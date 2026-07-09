const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'mealwheeliq-secret-change-in-production';

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://reviveiq.github.io', 'https://mealwheeliq.com', 'https://www.mealwheeliq.com',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ]
}));

// Raw body for Stripe webhooks
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// ─── DATABASE CONNECTION ─────────────────────────────────────────────────────
let db;

async function connectDB() {
  // First connect without a database to create it if needed
  const tempPool = await mysql.createPool({
    host: process.env.TIDB_HOST,
    port: parseInt(process.env.TIDB_PORT) || 4000,
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    ssl: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    waitForConnections: true,
    connectionLimit: 1,
    connectTimeout: 30000
  });
  await tempPool.execute(`CREATE DATABASE IF NOT EXISTS ${process.env.TIDB_DATABASE}`);
  await tempPool.end();

  // Now connect with the database
  db = await mysql.createPool({
    host: process.env.TIDB_HOST,
    port: parseInt(process.env.TIDB_PORT) || 4000,
    user: process.env.TIDB_USER,
    password: process.env.TIDB_PASSWORD,
    database: process.env.TIDB_DATABASE,
    ssl: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 30000
  });
  console.log('Connected to TiDB — database:', process.env.TIDB_DATABASE);
}

// ─── CREATE TABLES ───────────────────────────────────────────────────────────
async function createTables() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      stripe_customer_id VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      plan ENUM('free', 'trial', 'home_chef', 'family') DEFAULT 'free',
      status ENUM('active', 'cancelled', 'past_due', 'trialing') DEFAULT 'active',
      current_period_end TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNIQUE NOT NULL,
      daily_calorie_goal INT DEFAULT 2000,
      servings INT DEFAULT 2,
      dietary_preferences JSON,
      chef_name VARCHAR(50) DEFAULT 'Chef Claude',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_pantry (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      ingredient_name VARCHAR(255) NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_ingredient (user_id, ingredient_name),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS recipe_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      recipe_name VARCHAR(255) NOT NULL,
      emoji VARCHAR(10),
      cook_time VARCHAR(50),
      difficulty VARCHAR(50),
      style VARCHAR(100),
      calories_per_serving INT,
      protein_g INT,
      carbs_g INT,
      fat_g INT,
      ingredients JSON,
      steps JSON,
      saved BOOLEAN DEFAULT FALSE,
      spun_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS favorite_recipes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      recipe_id INT NOT NULL,
      saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (recipe_id) REFERENCES recipe_history(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS meal_plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      week_start_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS meal_plan_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      meal_plan_id INT NOT NULL,
      day ENUM('monday','tuesday','wednesday','thursday','friday') NOT NULL,
      recipe_id INT NOT NULL,
      FOREIGN KEY (meal_plan_id) REFERENCES meal_plans(id),
      FOREIGN KEY (recipe_id) REFERENCES recipe_history(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS spin_counts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      month VARCHAR(7) NOT NULL,
      count INT DEFAULT 0,
      last_spin_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_month (user_id, month),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS recipe_ratings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      recipe_id INT NOT NULL,
      stars TINYINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_recipe (user_id, recipe_id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS family_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_user_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      calorie_goal INT DEFAULT 2000,
      servings INT DEFAULT 2,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    )
  `);

  // ── Migrations — safe to run on every boot, errors mean column exists ────────
  const migrations = [
    { sql: "ALTER TABLE user_preferences ADD COLUMN chef_name VARCHAR(50) DEFAULT 'Chef'", name: 'chef_name' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN time VARCHAR(50)", name: 'time' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN difficulty VARCHAR(50)", name: 'difficulty' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN style VARCHAR(100)", name: 'style' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN fiber_g DECIMAL(5,1)", name: 'fiber_g' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN sodium_mg INT", name: 'sodium_mg' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN nutrition_source VARCHAR(50)", name: 'nutrition_source' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN image_url TEXT", name: 'image_url' },
    { sql: "ALTER TABLE recipe_history ADD COLUMN fiber_g DECIMAL(5,1)", name: 'fiber_g' },
  ];

  for (const m of migrations) {
    try {
      await db.execute(m.sql);
      console.log(`Migration applied: ${m.name}`);
    } catch(e) {
      // Column already exists — safe to ignore
    }
  }

  console.log('All tables created');
}

// Safe JSON parse — handles already-parsed objects (TiDB returns parsed JSON)
function safeJsonParse(val, fallback = []) {
  if (!val) return fallback;
  if (typeof val === 'object') return val; // already parsed by TiDB
  try { return JSON.parse(val); } catch { return fallback; }
}

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
async function getUserPlan(userId) {
  const [rows] = await db.execute(
    'SELECT plan, status FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  if (!rows.length) return 'free';
  if (rows[0].status !== 'active' && rows[0].status !== 'trialing') return 'free';
  return rows[0].plan;
}

async function getSpinCount(userId) {
  const month = new Date().toISOString().slice(0, 7);
  const [rows] = await db.execute(
    'SELECT count FROM spin_counts WHERE user_id = ? AND month = ?',
    [userId, month]
  );
  return rows.length ? rows[0].count : 0;
}

async function incrementSpinCount(userId) {
  const month = new Date().toISOString().slice(0, 7);
  await db.execute(
    `INSERT INTO spin_counts (user_id, month, count) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    [userId, month]
  );
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'MealsWheel API running 🍽️' });
});

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.execute(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [email.toLowerCase(), hash]
    );
    const userId = result.insertId;

    // Create free subscription and default preferences
    await db.execute('INSERT INTO subscriptions (user_id, plan, status) VALUES (?, "free", "active")', [userId]);
    await db.execute('INSERT INTO user_preferences (user_id) VALUES (?)', [userId]);

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, email, plan: 'free' } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const plan = await getUserPlan(user.id);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, plan } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, email, created_at FROM users WHERE id = ?', [req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const plan = await getUserPlan(req.user.userId);
    const spinCount = await getSpinCount(req.user.userId);
    res.json({ user: { ...rows[0], plan, spinCount } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ─── PREFERENCES ─────────────────────────────────────────────────────────────
app.get('/preferences', authMiddleware, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM user_preferences WHERE user_id = ?', [req.user.userId]);
  if (!rows.length) return res.json({ daily_calorie_goal: 2000, servings: 2, dietary_preferences: [], chef_name: 'Chef' });
  const r = rows[0];
  res.json({
    daily_calorie_goal: r.daily_calorie_goal,
    servings: r.servings,
    dietary_preferences: safeJsonParse(r.dietary_preferences, []),
    chef_name: r.chef_name || 'Chef'
  });
});

app.put('/preferences', authMiddleware, async (req, res) => {
  const { daily_calorie_goal, servings, dietary_preferences, chef_name } = req.body;
  await db.execute(
    `INSERT INTO user_preferences (user_id, daily_calorie_goal, servings, dietary_preferences, chef_name)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE daily_calorie_goal = ?, servings = ?, dietary_preferences = ?, chef_name = ?`,
    [req.user.userId, daily_calorie_goal, servings, JSON.stringify(dietary_preferences), chef_name || 'Chef',
     daily_calorie_goal, servings, JSON.stringify(dietary_preferences), chef_name || 'Chef']
  );
  res.json({ success: true });
});

// ─── PANTRY ──────────────────────────────────────────────────────────────────
app.get('/pantry', authMiddleware, async (req, res) => {
  const [rows] = await db.execute(
    'SELECT ingredient_name FROM user_pantry WHERE user_id = ? ORDER BY ingredient_name',
    [req.user.userId]
  );
  res.json(rows.map(r => r.ingredient_name));
});

app.post('/pantry', authMiddleware, async (req, res) => {
  const { ingredients } = req.body;
  if (!ingredients?.length) return res.status(400).json({ error: 'No ingredients provided' });

  // Replace all pantry items
  await db.execute('DELETE FROM user_pantry WHERE user_id = ?', [req.user.userId]);
  for (const ing of ingredients) {
    await db.execute(
      'INSERT IGNORE INTO user_pantry (user_id, ingredient_name) VALUES (?, ?)',
      [req.user.userId, ing]
    );
  }
  res.json({ success: true });
});

// ─── PANTRY PHOTO SCAN ───────────────────────────────────────────────────────
app.post('/pantry/scan', authMiddleware, async (req, res) => {
  const { image, mediaType } = req.body; // base64 image data, e.g. image/jpeg
  if (!image) return res.status(400).json({ error: 'No image provided' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: 'You are a kitchen inventory assistant. Identify food and ingredient items visible in the photo. Respond ONLY with valid JSON, no markdown, no prose.',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image }
            },
            {
              type: 'text',
              text: 'Identify every distinct food/ingredient item visible in this photo (fridge, pantry, or freezer). Use common grocery names (e.g. "Chicken Breast" not "raw poultry"). Skip non-food items, packaging-only views, and items you cannot confidently identify. Respond ONLY with valid JSON: {"items":["Chicken Breast","Broccoli","Cheddar Cheese"]}'
            }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Vision API error' });

    const raw = data.content?.map(b => b.text || '').join('') || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    let items = [];
    try {
      const parsed = JSON.parse(clean);
      items = parsed.items || [];
    } catch(e) {
      console.error('Pantry scan parse error:', e.message);
    }

    res.json({ items });
  } catch (err) {
    console.error('Pantry scan error:', err);
    res.status(500).json({ error: 'Pantry scan failed' });
  }
});

// ─── RECIPE GENERATION ───────────────────────────────────────────────────────
app.post('/generate', authMiddleware, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt provided' });

  // Check spin limit for free users
  const plan = await getUserPlan(req.user.userId);
  if (plan === 'free') {
    // Free trial: 5 lifetime spins
    const [totals] = await db.execute(
      'SELECT COALESCE(SUM(count),0) as total FROM spin_counts WHERE user_id=?',
      [req.user.userId]
    );
    const totalSpins = parseInt(totals[0].total) || 0;
    if (totalSpins >= 5) {
      return res.status(403).json({
        error: 'spin_limit_reached',
        message: 'Your 5 free spins are up! Upgrade to keep cooking.',
        spinCount: totalSpins,
        limit: 5
      });
    }
  }

  let recipes = [];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: `You are a professional chef AI. You MUST respond with valid JSON only — no markdown, no backticks, no prose. Your entire response must be parseable by JSON.parse().

ASSUMED KITCHEN STAPLES — never mark these buy:true, every home has them:
Fats: olive oil, vegetable oil, butter. Seasonings: salt, black pepper, garlic powder, onion powder, paprika, cumin, chili powder, oregano, thyme, rosemary, red pepper flakes, Italian seasoning, cinnamon. Condiments: soy sauce, Worcestershire sauce, hot sauce, Dijon mustard, ketchup, mayonnaise, honey, vinegar. Pantry: flour, sugar, cornstarch, chicken broth, beef broth. Aromatics: garlic, onion.

Recipe steps must follow professional cookbook standards (America's Test Kitchen / Bon Appétit style):
- Lead every step with an action verb (Heat, Sear, Brown, Stir, Whisk, Simmer, Roast, Toss, Garnish, Season)
- Combine related actions — never split "add X" and "stir X" into separate steps
- Include timing AND visual cues: "cook until golden, about 4 minutes" not just "cook chicken"
- Organize by cooking phase: Prep → Sear → Build flavor → Simmer/Bake → Finish → Serve
- Final step must season and include a service instruction
- Target 5–7 steps. Maximum 8. Eliminate all micro-steps.
- Never use passive voice or start steps with "The", "Once", or "After".`,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });

    // Increment spin count
    await incrementSpinCount(req.user.userId);

    // Parse and save to recipe history
    try {
      const raw = data.content.map(b => b.text || '').join('');
      let clean = raw.replace(/```json|```/g, '').trim();
      // Safety net: if JSON is truncated, attempt recovery
      try { JSON.parse(clean); } catch(e) {
        let recovered = clean;
        const lastStep = recovered.lastIndexOf('"]}');
        if (lastStep > 0) {
          recovered = recovered.substring(0, lastStep + 3);
          const openA = (recovered.match(/\[/g)||[]).length - (recovered.match(/\]/g)||[]).length;
          const openB = (recovered.match(/\{/g)||[]).length - (recovered.match(/\}/g)||[]).length;
          recovered += ']'.repeat(Math.max(0,openA)) + '}'.repeat(Math.max(0,openB));
        }
        try { JSON.parse(recovered); clean = recovered; } catch(e2) {
          clean = '{"recipes":[]}';
        }
      }
      const parsed = JSON.parse(clean);
      recipes = parsed.recipes || [];

      for (const r of recipes) {
        const [result] = await db.execute(
          `INSERT INTO recipe_history
           (user_id, recipe_name, emoji, cook_time, difficulty, style,
            calories_per_serving, protein_g, carbs_g, fat_g, ingredients, steps)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.userId, r.name, r.emoji, r.time, r.difficulty, r.style,
           r.calories_per_serving, r.protein_g, r.carbs_g, r.fat_g,
           JSON.stringify(r.ingredients), JSON.stringify(r.steps)]
        );
        r._id = result.insertId;
      }
    } catch (parseErr) {
      console.error('Could not save recipe to history:', parseErr.message);
    }

    // Return response with _id attached to each recipe so frontend can save favorites/ratings
    res.json({
      ...data,
      content: [{ type: 'text', text: JSON.stringify({ recipes }) }]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Recipe generation failed' });
  }
});

// ─── RECIPE HISTORY ──────────────────────────────────────────────────────────
app.get('/history', authMiddleware, async (req, res) => {
  const plan = await getUserPlan(req.user.userId);
  // Free users get no history — return empty array
  if (plan === 'free') return res.json([]);
  const [rows] = await db.execute(
    'SELECT * FROM recipe_history WHERE user_id = ? ORDER BY spun_at DESC LIMIT 1000',
    [req.user.userId]
  );
  res.json(rows.map(r => ({
    ...r,
    ingredients: safeJsonParse(r.ingredients),
    steps: safeJsonParse(r.steps)
  })));
});

app.put('/history/:id/save', authMiddleware, async (req, res) => {
  await db.execute(
    'UPDATE recipe_history SET saved = TRUE WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  res.json({ success: true });
});

// ─── FAVORITES ───────────────────────────────────────────────────────────────
app.get('/favorites', authMiddleware, async (req, res) => {
  const [rows] = await db.execute(
    `SELECT rh.* FROM recipe_history rh
     JOIN favorite_recipes fr ON rh.id = fr.recipe_id
     WHERE fr.user_id = ? ORDER BY fr.saved_at DESC`,
    [req.user.userId]
  );
  res.json(rows.map(r => ({
    ...r,
    ingredients: safeJsonParse(r.ingredients),
    steps: safeJsonParse(r.steps)
  })));
});

app.post('/favorites/:recipeId', authMiddleware, async (req, res) => {
  try {
    await db.execute(
      'INSERT INTO favorite_recipes (user_id, recipe_id) VALUES (?, ?)',
      [req.user.userId, req.params.recipeId]
    );
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Already favorited' });
  }
});

app.delete('/favorites/:recipeId', authMiddleware, async (req, res) => {
  await db.execute(
    'DELETE FROM favorite_recipes WHERE user_id = ? AND recipe_id = ?',
    [req.user.userId, req.params.recipeId]
  );
  res.json({ success: true });
});

// ─── MEAL PLANS ──────────────────────────────────────────────────────────────
app.get('/mealplans', authMiddleware, async (req, res) => {
  const [plans] = await db.execute(
    'SELECT * FROM meal_plans WHERE user_id = ? ORDER BY week_start_date DESC LIMIT 10',
    [req.user.userId]
  );
  for (const plan of plans) {
    const [items] = await db.execute(
      `SELECT mpi.day, rh.* FROM meal_plan_items mpi
       JOIN recipe_history rh ON mpi.recipe_id = rh.id
       WHERE mpi.meal_plan_id = ? ORDER BY FIELD(mpi.day,'monday','tuesday','wednesday','thursday','friday')`,
      [plan.id]
    );
    plan.items = items.map(r => ({
      ...r,
      ingredients: typeof r.ingredients === 'string' ? JSON.parse(r.ingredients || '[]') : (r.ingredients || []),
      steps: typeof r.steps === 'string' ? JSON.parse(r.steps || '[]') : (r.steps || [])
    }));
  }
  res.json(plans);
});

app.post('/mealplans', authMiddleware, async (req, res) => {
  const { week_start_date, items } = req.body;
  const [result] = await db.execute(
    'INSERT INTO meal_plans (user_id, week_start_date) VALUES (?, ?)',
    [req.user.userId, week_start_date]
  );
  const planId = result.insertId;
  for (const item of items) {
    await db.execute(
      'INSERT INTO meal_plan_items (meal_plan_id, day, recipe_id) VALUES (?, ?, ?)',
      [planId, item.day, item.recipe_id]
    );
  }
  res.json({ success: true, planId });
});

// ─── FAMILY PROFILES ─────────────────────────────────────────────────────────
app.get('/profiles', authMiddleware, async (req, res) => {
  const plan = await getUserPlan(req.user.userId);
  if (plan !== 'family') return res.status(403).json({ error: 'Family plan required. Upgrade to the Family plan for multiple profiles.' });
  const [rows] = await db.execute(
    'SELECT * FROM family_profiles WHERE owner_user_id = ?',
    [req.user.userId]
  );
  res.json(rows);
});

app.post('/profiles', authMiddleware, async (req, res) => {
  const plan = await getUserPlan(req.user.userId);
  if (plan !== 'family') return res.status(403).json({ error: 'Family plan required. Upgrade to the Family plan for multiple profiles.' });
  const [existing] = await db.execute(
    'SELECT COUNT(*) as count FROM family_profiles WHERE owner_user_id = ?',
    [req.user.userId]
  );
  if (existing[0].count >= 4) return res.status(400).json({ error: 'Maximum 4 profiles on Family plan' });
  const { name, calorie_goal, servings } = req.body;
  const [result] = await db.execute(
    'INSERT INTO family_profiles (owner_user_id, name, calorie_goal, servings) VALUES (?, ?, ?, ?)',
    [req.user.userId, name, calorie_goal || 2000, servings || 2]
  );
  res.json({ success: true, id: result.insertId });
});

// ─── RECIPE RATING ──────────────────────────────────────────────────────────
app.post('/recipes/:id/rate', authMiddleware, async (req, res) => {
  const { stars } = req.body;
  const recipeId = parseInt(req.params.id);
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'stars must be 1-5' });
  try {
    const [rows] = await db.execute('SELECT id FROM recipe_history WHERE id=? AND user_id=?', [recipeId, req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
    await db.execute(
      'INSERT INTO recipe_ratings (user_id, recipe_id, stars) VALUES (?,?,?) ON DUPLICATE KEY UPDATE stars=?',
      [req.user.userId, recipeId, stars, stars]
    );
    res.json({ success: true, stars });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save rating' });
  }
});

app.get('/top-recipes', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT rh.recipe_name, rh.emoji, rh.style, rh.calories_per_serving,
             ROUND(AVG(rr.stars),1) as avg_stars, COUNT(rr.id) as rating_count
      FROM recipe_ratings rr
      JOIN recipe_history rh ON rh.id = rr.recipe_id
      WHERE rr.stars >= 4
      GROUP BY rh.id
      HAVING rating_count >= 1
      ORDER BY avg_stars DESC, rating_count DESC
      LIMIT 6
    `);
    res.json(rows);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch top recipes' });
  }
});

// ─── STRIPE PAYMENTS ─────────────────────────────────────────────────────────
app.post('/subscribe', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured yet' });
  const { plan } = req.body;
  const prices = {
    trial: process.env.STRIPE_TRIAL_PRICE_ID || null,
    home_chef: process.env.STRIPE_HOME_CHEF_PRICE_ID || null,
    family: process.env.STRIPE_FAMILY_PRICE_ID || null
  };
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const [users] = await db.execute('SELECT email FROM users WHERE id = ?', [req.user.userId]);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: users[0].email,
      line_items: [{ price: prices[plan], quantity: 1 }],
      metadata: { userId: req.user.userId, plan },
      success_url: 'https://mealwheeliq.com?subscribed=true',
      cancel_url: 'https://mealwheeliq.com?cancelled=true'
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId || null;
    const plan = session.metadata?.plan || 'free';
    const customer = session.customer || null;
    const subscription = session.subscription || null;
    if (userId) {
      await db.execute(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status)
         VALUES (?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE plan = ?, status = 'active', stripe_subscription_id = ?`,
        [userId, customer, subscription, plan, plan, subscription]
      );
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await db.execute(
      'UPDATE subscriptions SET status = "cancelled" WHERE stripe_subscription_id = ?',
      [sub.id]
    );
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    await db.execute(
      'UPDATE subscriptions SET status = "past_due" WHERE stripe_subscription_id = ?',
      [invoice.subscription]
    );
  }

  // QuickSpin one-time payment
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const quickspinToken = session.metadata?.quickspinToken;
    if (quickspinToken && quickspinSessions.has(quickspinToken)) {
      const qs = quickspinSessions.get(quickspinToken);
      qs.paid = true;
      quickspinSessions.set(quickspinToken, qs);
      console.log('QuickSpin payment confirmed:', quickspinToken);
    }
  }

  res.json({ received: true });
});



// POST /recipe/:id/og-page — build and push static OG HTML + image to GitHub Pages
app.post('/recipe/:id/og-page', authMiddleware, async (req, res) => {
  const recipeId = req.params.id;
  const { imageUrl } = req.body;
  const https = require('https');
  const ghToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;

  // Helper: GitHub API call using native https
  const ghRequest = (method, url, body, token) => new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: parsed.hostname, path: parsed.pathname, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'MealWheelIQ/1.0',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, r => {
      let buf = ''; r.on('data', c => buf += c);
      r.on('end', () => { try { resolve({ status: r.statusCode, data: JSON.parse(buf) }); } catch(e) { resolve({ status: r.statusCode, data: buf }); }});
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  // Helper: push file to GitHub
  const ghPush = async (path, content, message) => {
    const url = `https://api.github.com/repos/ReviveIQ/mealwheeliq/contents/${path}`;
    let sha = null;
    try { const c = await ghRequest('GET', url, null, ghToken); if (c.status === 200) sha = c.data.sha; } catch(e) {}
    const body = { message, content };
    if (sha) body.sha = sha;
    const result = await ghRequest('PUT', url, body, ghToken);
    console.log(`GitHub push ${path}:`, result.status, result.data?.commit?.sha?.slice(0,7) || result.data?.message || '');
    return result;
  };

  try {
    const [rows] = await db.execute(
      'SELECT id, recipe_name, emoji, time, difficulty, style, calories_per_serving, protein_g, carbs_g, fat_g, ingredients FROM recipe_history WHERE id = ? AND user_id = ?',
      [recipeId, req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
    const r = rows[0];
    const ings = typeof r.ingredients === 'string' ? JSON.parse(r.ingredients || '[]') : (r.ingredients || []);
    const top3 = ings.slice(0, 3).map(i => i.name).join(', ');
    const more = ings.length > 3 ? ` + ${ings.length - 3} more` : '';

    const title = `${r.emoji || '🍽️'} ${r.recipe_name} — MealWheelIQ`;
    const desc = `${r.recipe_name}: ${top3}${more}. ${r.time || '30 min'} · ${r.calories_per_serving} kcal · Spun on MealWheelIQ — get your own AI recipe free at mealwheeliq.com`;
    const pageUrl = `https://mealwheeliq.com/recipe.html?id=${r.id}`;
    const ogUrl = `https://mealwheeliq.com/og/${recipeId}.html`;

    // Check DB for cached image
    const [imgCache] = await db.execute('SELECT image_url FROM recipe_history WHERE id = ?', [recipeId]);
    let finalImgUrl = imgCache[0]?.image_url || null;
    console.log('Cached image:', finalImgUrl ? 'yes' : 'no');

    if (!finalImgUrl && process.env.OPENAI_API_KEY) {
      // Generate with gpt-image-1 — returns base64, store permanently in GitHub
      try {
        console.log('Generating image with gpt-image-1...');
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const prompt = `Professional food photography of ${r.recipe_name}. Overhead shot, rustic wooden table, natural lighting, beautifully plated, appetizing and magazine-quality. No text, photorealistic.`;

        const imgResp = await Promise.race([
          openai.images.generate({ model: 'gpt-image-1', prompt, n: 1, size: '1024x1024' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 25s')), 25000))
        ]);

        const b64 = imgResp.data[0].b64_json;
        if (b64) {
          await ghPush(`og/img/${recipeId}.png`, b64, `img: recipe ${recipeId} AI food photo`);
          finalImgUrl = `https://mealwheeliq.com/og/img/${recipeId}.png`;
          await db.execute('UPDATE recipe_history SET image_url = ? WHERE id = ?', [finalImgUrl, recipeId]);
          console.log('gpt-image-1 stored:', finalImgUrl);
        }
      } catch(e) {
        console.log('gpt-image-1 failed:', e.message);
      }
    } else if (!finalImgUrl) {
      console.log('OPENAI_API_KEY not set — skipping image generation');
    }

    // Unsplash fallback if no AI image
    if (!finalImgUrl) {
      try {
        const searchQuery = encodeURIComponent(r.recipe_name.split(' ').slice(0,3).join(' ') + ' food');
        const unsplashUrl = `https://source.unsplash.com/1200x630/?${searchQuery}`;
        const resolvedUrl = await new Promise((resolve, reject) => {
          https.get(unsplashUrl, { headers: { 'User-Agent': 'MealWheelIQ/1.0' } }, res => {
            resolve(res.headers.location || (res.statusCode === 200 ? unsplashUrl : null));
            res.destroy();
          }).on('error', () => resolve(null));
        });
        if (resolvedUrl) {
          finalImgUrl = resolvedUrl;
          await db.execute('UPDATE recipe_history SET image_url = ? WHERE id = ?', [finalImgUrl, recipeId]);
          console.log('Unsplash image:', finalImgUrl.slice(0,80));
        }
      } catch(e) { console.log('Unsplash failed:', e.message); }
    }

    if (!finalImgUrl) finalImgUrl = 'https://mealwheeliq.com/icons/icon-512.png';

    // Build OG HTML with permanent image URL
    const html = `<!DOCTYPE html>
<html prefix="og: http://ogp.me/ns#">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${finalImgUrl}">
  <meta property="og:image:secure_url" content="${finalImgUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:alt" content="${r.recipe_name} — made with MealWheelIQ">
  <meta property="og:url" content="${ogUrl}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MealWheelIQ - AI Dinner Planning">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${finalImgUrl}">
  <link rel="canonical" href="${pageUrl}">
  <!-- real users click the link below; no redirect so Facebook reads these OG tags -->
</head>
<body style="font-family:sans-serif;max-width:600px;margin:2rem auto;padding:1rem;text-align:center">
  <h1>${r.recipe_name}</h1>
  <p style="color:#666;margin:1rem 0">${desc}</p>
  <a href="${pageUrl}" style="background:#C94B2A;color:white;padding:.75rem 2rem;border-radius:24px;text-decoration:none;font-weight:700;display:inline-block;margin-top:1rem">
    View full recipe on MealWheelIQ →
  </a>
  <p style="color:#999;font-size:12px;margin-top:2rem">
    <a href="https://mealwheeliq.com" style="color:#C94B2A">MealWheelIQ</a> — Spin it. Cook it. Love it.
  </p>
</body>
</html>`;

    if (ghToken) {
      await ghPush(`og/${recipeId}.html`, Buffer.from(html).toString('base64'), `feat: OG page for recipe ${recipeId} — ${r.recipe_name}`);
    }

    res.json({ pageUrl: ogUrl });
  } catch(e) {
    console.error('OG page error:', e.message);
    res.json({ pageUrl: `https://mealwheeliq.com/recipe.html?id=${recipeId}` });
  }
});


// ─── PUBLIC RECIPE PAGE ───────────────────────────────────────────────────────

// GET /recipe/:id — public recipe data for shared recipe pages (no auth needed)
app.get('/recipe/:id', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, recipe_name, emoji, time, difficulty, style, calories_per_serving, protein_g, carbs_g, fat_g, ingredients, steps, nutrition_source FROM recipe_history WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Recipe not found' });
    const r = rows[0];
    res.json({
      ...r,
      ingredients: typeof r.ingredients === 'string' ? JSON.parse(r.ingredients || '[]') : (r.ingredients || []),
      steps: typeof r.steps === 'string' ? JSON.parse(r.steps || '[]') : (r.steps || [])
    });
  } catch(e) {
    console.error('Public recipe error:', e);
    res.status(500).json({ error: 'Failed to load recipe' });
  }
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

// Simple admin auth — checks for ADMIN_SECRET env var
const adminAuth = (req, res, next) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// GET /admin/user?email=xxx or ?id=xxx — look up a user
app.get('/admin/user', adminAuth, async (req, res) => {
  const { email, id } = req.query;
  if (!email && !id) return res.status(400).json({ error: 'Provide email or id' });
  try {
    const where = id ? 'u.id = ?' : 'u.email = ?';
    const val = id || email;
    const [rows] = await db.execute(
      `SELECT u.id, u.email, u.created_at, s.plan, s.status, s.stripe_customer_id,
       (SELECT COUNT(*) FROM recipe_history WHERE user_id = u.id) as recipe_count,
       (SELECT COUNT(*) FROM spin_counts WHERE user_id = u.id) as spin_months
       FROM users u LEFT JOIN subscriptions s ON u.id = s.user_id WHERE ${where}`,
      [val]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/upgrade — upgrade a user's plan
// Body: { userId, plan } — plan: 'free' | 'home_chef' | 'family'
app.post('/admin/upgrade', adminAuth, async (req, res) => {
  const { userId, plan } = req.body;
  const validPlans = ['free', 'home_chef', 'family'];
  if (!userId || !plan || !validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Provide userId and valid plan (free/home_chef/family)' });
  }
  try {
    // Check user exists
    const [users] = await db.execute('SELECT id, email FROM users WHERE id = ?', [userId]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });

    // Update plan
    const [result] = await db.execute(
      'UPDATE subscriptions SET plan = ?, status = "active" WHERE user_id = ?',
      [plan, userId]
    );

    if (result.affectedRows === 0) {
      // No subscription row exists — insert one
      await db.execute(
        'INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, "active")',
        [userId, plan]
      );
    }

    // Clear spin count so they start fresh
    if (plan !== 'free') {
      await db.execute('DELETE FROM spin_counts WHERE user_id = ?', [userId]);
    }

    res.json({
      success: true,
      user: users[0].email,
      userId,
      plan,
      message: `${users[0].email} upgraded to ${plan}`
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/users — list recent users
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT u.id, u.email, u.created_at, s.plan, s.status,
       (SELECT COUNT(*) FROM recipe_history WHERE user_id = u.id) as recipes
       FROM users u LEFT JOIN subscriptions s ON u.id = s.user_id
       ORDER BY u.created_at DESC LIMIT 50`
    );
    res.json({ users: rows, count: rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── QUICKSPIN — ONE-TIME PURCHASE ───────────────────────────────────────────

const { Resend } = (() => {
  try { return require('resend'); } catch(e) { return { Resend: null }; }
})();
const resend = Resend && process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const crypto = require('crypto');

// In-memory store for quickspin sessions (no DB needed — expires after 24h)
const quickspinSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of quickspinSessions) {
    if (v.createdAt < cutoff) quickspinSessions.delete(k);
  }
}, 60 * 60 * 1000);

// POST /quickspin/checkout — create Stripe checkout session
app.post('/quickspin/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { mode, contact, contactType } = req.body; // mode: 'tonight' or 'week'
  if (!mode || !contact || !contactType) return res.status(400).json({ error: 'Missing required fields' });

  const priceId = process.env.STRIPE_QUICKSPIN_PRICE_ID;
  if (!priceId) return res.status(503).json({ error: 'QuickSpin price not configured' });

  // Generate a session token to pass through Stripe metadata
  const token = crypto.randomBytes(32).toString('hex');
  quickspinSessions.set(token, { mode, contact, contactType, paid: false, createdAt: Date.now() });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { quickspinToken: token, mode, contact, contactType },
      customer_email: contactType === 'email' ? contact : undefined,
      success_url: `https://mealwheeliq.com/quickspin.html?token=${token}&success=true`,
      cancel_url: 'https://mealwheeliq.com/quickspin.html?cancelled=true'
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('QuickSpin checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /quickspin/preview — generate preview for FREE before payment
// Results are cached by preview token and unlocked after Stripe payment
const previewCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2hr expiry
  for (const [k, v] of previewCache) {
    if (v.createdAt < cutoff) previewCache.delete(k);
  }
}, 30 * 60 * 1000);

app.post('/quickspin/preview', async (req, res) => {
  const { mode, ingredients, craving } = req.body;
  if (!mode) return res.status(400).json({ error: 'Mode required' });

  const ingList = (ingredients || []).join(', ') || 'common household ingredients';
  const cravingLine = craving ? `
The user is craving: "${craving}" — incorporate this.` : '';
  const STAPLES = 'olive oil, vegetable oil, butter, salt, black pepper, garlic powder, onion powder, all common spices, soy sauce, Worcestershire, hot sauce, mustard, ketchup, mayo, honey, vinegar, flour, sugar, garlic, onion';

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    let recipes = [];

    if (mode === 'tonight') {
      const prompt = `You are a professional chef. Generate 1 delicious dinner recipe.${cravingLine}
Available ingredients: ${ingList}
ASSUMED STAPLES (never mark buy:true): ${STAPLES}
Suggest 3-5 ingredients to buy (buy:true). Flag organic:true for meats, eggs, leafy greens.
Servings: 2. Target ~600 kcal/serving.
Respond ONLY with valid JSON: {"recipes":[{"name":"Name","emoji":"🍽️","time":"30 min","difficulty":"Easy","style":"American","calories_per_serving":600,"protein_g":35,"carbs_g":50,"fat_g":20,"ingredients":[{"name":"item","organic":false,"buy":false}],"steps":["Step 1."]}]}`;

      const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
      const parsed = JSON.parse(msg.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
      recipes = parsed.recipes || [];

    } else {
      const dayStyles = [
        { day: 'Monday', style: 'bold American comfort food or BBQ-inspired' },
        { day: 'Tuesday', style: 'fresh Mediterranean or Italian' },
        { day: 'Wednesday', style: 'LIGHT & FRESH — big chopped salad, grain bowl, or wrap. Homemade dressing with exact measurements.' },
        { day: 'Thursday', style: 'bold Asian-inspired stir fry, Thai, or Korean BBQ' },
        { day: 'Friday', style: 'creative wildcard — something unexpected and fun' }
      ];
      const avoidNames = [];
      for (const { day, style } of dayStyles) {
        const avoidStr = avoidNames.length ? `Do NOT repeat: ${avoidNames.join(', ')}.` : '';
        const prompt = `You are a professional chef. Generate 1 dinner recipe for ${day}.
STYLE: ${style}${cravingLine}
Available ingredients: ${ingList}
ASSUMED STAPLES (never mark buy:true): ${STAPLES}
${avoidStr}
Suggest 3-5 fresh ingredients to buy (buy:true). Flag organic:true for meats, eggs, leafy greens.
Servings: 2. Target ~650 kcal/serving.
Respond ONLY with valid JSON: {"recipes":[{"name":"Name","emoji":"🍽️","time":"35 min","difficulty":"Easy","style":"${day}","calories_per_serving":650,"protein_g":38,"carbs_g":55,"fat_g":22,"ingredients":[{"name":"item","organic":false,"buy":false}],"steps":["Step 1."]}]}`;
        const msg = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
        const parsed = JSON.parse(msg.content.map(b=>b.text||'').join('').replace(/```json|```/g,'').trim());
        if (parsed.recipes?.[0]) {
          recipes.push({ ...parsed.recipes[0], day });
          avoidNames.push(parsed.recipes[0].name);
        }
      }
    }

    // Cache preview
    const previewToken = crypto.randomBytes(16).toString('hex');
    previewCache.set(previewToken, { mode, recipes, createdAt: Date.now() });
    res.json({ mode, recipes, previewToken });

  } catch(e) {
    console.error('Preview error:', e);
    res.status(500).json({ error: 'Preview generation failed' });
  }
});

// POST /quickspin/generate — generate recipe(s) for paid session
app.post('/quickspin/generate', async (req, res) => {
  const { token, ingredients, craving, previewToken } = req.body;
  const session = quickspinSessions.get(token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  if (!session.paid) return res.status(402).json({ error: 'Payment required' });
  if (session.generated) return res.status(200).json(session.result); // return cached result

  // If we have a cached preview, use it instead of regenerating
  if (previewToken && previewCache.has(previewToken)) {
    const preview = previewCache.get(previewToken);
    session.generated = true;
    session.result = { mode: preview.mode, recipes: preview.recipes };
    quickspinSessions.set(token, session);
    previewCache.delete(previewToken);
    return res.json(session.result);
  }

  const { mode } = session;
  const ingList = (ingredients || []).join(', ') || 'common household ingredients';
  const cravingLine = craving ? `\nThe user is craving: "${craving}" — incorporate this.` : '';

  const STAPLES = 'olive oil, vegetable oil, butter, salt, black pepper, garlic powder, onion powder, all common spices, soy sauce, Worcestershire, hot sauce, mustard, ketchup, mayo, honey, vinegar, flour, sugar, garlic, onion';

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    let result;
    if (mode === 'tonight') {
      const prompt = `You are a professional chef. Generate 1 delicious dinner recipe.${cravingLine}
Available ingredients: ${ingList}
ASSUMED STAPLES (never mark buy:true): ${STAPLES}
Suggest 2-4 ingredients to buy (buy:true). Flag organic:true for meats, eggs, leafy greens.
Servings: 2. Target ~600 kcal/serving.
Respond ONLY with valid JSON: {"recipes":[{"name":"Name","emoji":"🍽️","time":"30 min","difficulty":"Easy","style":"American","calories_per_serving":600,"protein_g":35,"carbs_g":50,"fat_g":20,"ingredients":[{"name":"item","organic":false,"buy":false}],"steps":["Step 1."]}]}`;

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = message.content.map(b => b.text || '').join('');
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      result = { mode: 'tonight', recipes: parsed.recipes };

    } else {
      // Week mode — generate all 5 nights
      const dayStyles = [
        { day: 'Monday', style: 'bold American comfort food or BBQ-inspired (burgers, ribs, mac & cheese)' },
        { day: 'Tuesday', style: 'fresh Mediterranean or Italian (pasta, fish, antipasto)' },
        { day: 'Wednesday', style: 'LIGHT & FRESH — big chopped salad, grain bowl, or wrap. No-cook or minimal cook. Homemade dressing with exact measurements.' },
        { day: 'Thursday', style: 'bold Asian-inspired (stir fry, Thai peanut noodles, teriyaki, Korean BBQ)' },
        { day: 'Friday', style: 'CREATIVE WILDCARD — something unexpected and fun the family will love' }
      ];

      const recipes = [];
      const avoidNames = [];
      for (const { day, style } of dayStyles) {
        const avoidStr = avoidNames.length ? `Do NOT repeat: ${avoidNames.join(', ')}.` : '';
        const prompt = `You are a professional chef. Generate 1 dinner recipe for ${day}.
STYLE: ${style}${cravingLine}
Available ingredients: ${ingList}
ASSUMED STAPLES (never mark buy:true): ${STAPLES}
${avoidStr}
Suggest 3-5 fresh ingredients to buy (buy:true). Flag organic:true for meats, eggs, leafy greens.
Servings: 2. Target ~650 kcal/serving.
Respond ONLY with valid JSON: {"recipes":[{"name":"Name","emoji":"🍽️","time":"35 min","difficulty":"Easy","style":"${day}","calories_per_serving":650,"protein_g":38,"carbs_g":55,"fat_g":22,"ingredients":[{"name":"item","organic":false,"buy":false}],"steps":["Step 1."]}]}`;

        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        });
        const raw = message.content.map(b => b.text || '').join('');
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        if (parsed.recipes?.[0]) {
          recipes.push({ ...parsed.recipes[0], day });
          avoidNames.push(parsed.recipes[0].name);
        }
      }
      result = { mode: 'week', recipes };
    }

    session.generated = true;
    session.result = result;
    quickspinSessions.set(token, session);
    res.json(result);
  } catch (err) {
    console.error('QuickSpin generate error:', err);
    res.status(500).json({ error: 'Generation failed — please try again' });
  }
});

// POST /quickspin/mixup — swap one recipe (limited to 1 use per session)
app.post('/quickspin/mixup', async (req, res) => {
  const { token, dayIndex, ingredients, craving } = req.body;
  const session = quickspinSessions.get(token);
  if (!session || !session.paid) return res.status(402).json({ error: 'Invalid session' });
  if (session.mixupUsed) return res.status(403).json({ error: 'Mix up already used for this purchase' });

  const ingList = (ingredients || []).join(', ') || 'common household ingredients';
  const STAPLES = 'olive oil, vegetable oil, butter, salt, black pepper, garlic powder, onion powder, all common spices, soy sauce, Worcestershire, hot sauce, mustard, ketchup, mayo, honey, vinegar, flour, sugar, garlic, onion';
  const ALL_STYLES = ['Bold American / BBQ','Mediterranean / Italian','Light & Fresh bowl or salad','Asian-inspired stir fry or noodles','Mexican or Latin-American','Creative wildcard','Japanese-inspired','Slow & cozy stew or soup','Seafood night','Steakhouse at home','Fun family night (pizza, tacos bar, sliders)'];
  const currentNames = session.result?.recipes?.map(r => r.name) || [];
  const randomStyle = ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)];
  const avoidStr = currentNames.length ? `Do NOT repeat any of: ${currentNames.join(', ')}.` : '';
  const dayName = ['Monday','Tuesday','Wednesday','Thursday','Friday'][dayIndex] || 'tonight';
  const cravingLine = craving ? `\nUser is craving: "${craving}".` : '';

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const prompt = `You are a professional chef. Generate 1 dinner recipe for ${dayName}.
STYLE: ${randomStyle}${cravingLine}
Available ingredients: ${ingList}
ASSUMED STAPLES (never mark buy:true): ${STAPLES}
${avoidStr}
Suggest 3-5 ingredients to buy (buy:true). Flag organic:true for meats, eggs, leafy greens.
Servings: 2. Target ~650 kcal/serving.
Respond ONLY with valid JSON: {"recipes":[{"name":"Name","emoji":"🍽️","time":"35 min","difficulty":"Easy","style":"${randomStyle}","calories_per_serving":650,"protein_g":38,"carbs_g":55,"fat_g":22,"ingredients":[{"name":"item","organic":false,"buy":false}],"steps":["Step 1."]}]}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = message.content.map(b => b.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const newRecipe = parsed.recipes?.[0];
    if (!newRecipe) throw new Error('No recipe returned');

    // Update session
    if (session.result?.recipes && dayIndex !== undefined) {
      session.result.recipes[dayIndex] = { ...newRecipe, day: dayName };
    } else if (session.result?.recipes) {
      session.result.recipes.push(newRecipe);
    }
    session.mixupUsed = true;
    quickspinSessions.set(token, session);

    res.json({ recipe: newRecipe, mixupUsed: true });
  } catch (err) {
    console.error('QuickSpin mixup error:', err);
    res.status(500).json({ error: 'Mix up failed — please try again' });
  }
});

// POST /quickspin/email — send results via Resend
app.post('/quickspin/email', async (req, res) => {
  const { token } = req.body;
  const session = quickspinSessions.get(token);
  if (!session || !session.paid) return res.status(402).json({ error: 'Invalid session' });
  if (session.emailSent) return res.status(200).json({ sent: true, cached: true });

  const { mode, contact, contactType, result } = session;
  if (!result) return res.status(400).json({ error: 'No results to send yet' });
  if (contactType !== 'email') return res.status(200).json({ sent: false, reason: 'SMS not yet supported' });
  if (!resend) return res.status(503).json({ error: 'Email not configured' });

  const recipes = result.recipes || [];
  const isWeek = mode === 'week';

  // Build grocery list
  const ingMap = {};
  const PROT = ['beef','chicken','pork','salmon','shrimp','sausage','bacon','egg','fish','turkey','lamb','steak','ground','tofu'];
  const PROD = ['potato','carrot','squash','pepper','spinach','broccoli','lemon','lime','avocado','tomato','mushroom','kale','cucumber','herbs','cilantro','basil','ginger'];
  const DAIRY = ['cheese','butter','cream','milk','yogurt','mozzarella','feta'];
  recipes.forEach((r, di) => {
    (r.ingredients || []).filter(i => i.buy).forEach(ing => {
      const k = ing.name.toLowerCase();
      if (!ingMap[k]) ingMap[k] = { name: ing.name, organic: ing.organic, days: [] };
      if (isWeek) ingMap[k].days.push(r.day || `Night ${di+1}`);
    });
  });
  const cats = { 'Proteins': [], 'Produce': [], 'Dairy': [], 'Pantry & Other': [] };
  Object.values(ingMap).forEach(ing => {
    const k = ing.name.toLowerCase();
    if (PROT.some(p => k.includes(p))) cats['Proteins'].push(ing);
    else if (PROD.some(p => k.includes(p))) cats['Produce'].push(ing);
    else if (DAIRY.some(p => k.includes(p))) cats['Dairy'].push(ing);
    else cats['Pantry & Other'].push(ing);
  });

  const today = new Date();
  const daysUntilSunday = (7 - today.getDay()) % 7 || 7;
  const buyBy = new Date(today.getTime() + daysUntilSunday * 86400000);
  const buyByStr = buyBy.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  // Build HTML email
  const groceryHTML = Object.entries(cats).filter(([,items]) => items.length).map(([cat, items]) => `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8C7B72;margin-bottom:8px">${cat}</div>
      ${items.map(i => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #EAE5DF">
          <span style="font-size:14px;color:#1C1714">${i.organic ? '🌿 ' : ''}${i.name}</span>
          ${isWeek && i.days.length ? `<span style="font-size:11px;color:#8C7B72;background:#FAF8F5;padding:2px 8px;border-radius:10px">${i.days.join(', ')}</span>` : ''}
        </div>`).join('')}
    </div>`).join('');

  const recipesHTML = recipes.map((r, i) => `
    <div style="background:#FFFFFF;border:1px solid #EAE5DF;border-radius:16px;padding:24px;margin-bottom:20px">
      ${isWeek ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#C94B2A;margin-bottom:6px">${r.day || ''}</div>` : ''}
      <div style="font-size:24px;margin-bottom:4px">${r.emoji || '🍽️'}</div>
      <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#1C1714;margin:0 0 8px">${r.name}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <span style="background:#FAF8F5;border:1px solid #EAE5DF;border-radius:20px;padding:4px 12px;font-size:12px;color:#4A3F38">⏱ ${r.time}</span>
        <span style="background:#FAF8F5;border:1px solid #EAE5DF;border-radius:20px;padding:4px 12px;font-size:12px;color:#4A3F38">${r.difficulty}</span>
        <span style="background:#EAF3EE;border-radius:20px;padding:4px 12px;font-size:12px;color:#2A6B4A">🔥 ${r.calories_per_serving} kcal</span>
        <span style="background:#EAF3EE;border-radius:20px;padding:4px 12px;font-size:12px;color:#2A6B4A">💪 ${r.protein_g}g protein</span>
      </div>
      <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8C7B72;margin:0 0 10px">Ingredients</h3>
      <ul style="padding-left:18px;margin:0 0 20px">
        ${(r.ingredients || []).map(ing => `<li style="font-size:14px;color:#4A3F38;margin-bottom:4px;padding-left:4px">
          ${ing.organic ? '<span style="color:#2A6B4A">🌿 </span>' : ''}
          <strong style="color:${ing.buy ? '#C94B2A' : '#1C1714'}">${ing.name}</strong>
          ${ing.buy ? ' <span style="font-size:11px;color:#C94B2A;background:#FAF0EB;padding:1px 6px;border-radius:8px">buy</span>' : ''}
        </li>`).join('')}
      </ul>
      <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8C7B72;margin:0 0 10px">Instructions</h3>
      <ol style="padding-left:18px;margin:0">
        ${(r.steps || []).map(step => `<li style="font-size:14px;color:#4A3F38;margin-bottom:8px;line-height:1.6">${step}</li>`).join('')}
      </ol>
    </div>`).join('');

  const subject = isWeek
    ? `🍽️ Your 5-night meal plan is ready — MealWheelIQ`
    : `🍽️ Tonight's dinner recipe from MealWheelIQ`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAF8F5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="text-align:center;padding:32px 0 24px">
    <div style="font-family:Georgia,serif;font-size:28px;font-weight:700;color:#1C1714">MealWheel<span style="color:#C94B2A">IQ</span></div>
    <div style="font-size:13px;color:#8C7B72;margin-top:4px">Spin it. Cook it. Love it.</div>
  </div>

  <div style="background:#C94B2A;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px">
    <div style="font-size:32px;margin-bottom:8px">${isWeek ? '📅' : '🍽️'}</div>
    <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:white;margin-bottom:6px">
      ${isWeek ? 'Your week is planned!' : "Tonight's dinner is ready!"}
    </div>
    <div style="font-size:14px;color:rgba(255,255,255,.8)">
      ${isWeek ? `${recipes.length} dinners · complete grocery list · step-by-step instructions` : `Full recipe · ingredients · step-by-step instructions`}
    </div>
  </div>

  ${isWeek ? `
  <div style="background:white;border:1px solid #EAE5DF;border-radius:16px;padding:20px;margin-bottom:24px">
    <h2 style="font-size:16px;font-weight:700;color:#1C1714;margin:0 0 16px">🛒 Weekly Grocery List</h2>
    <div style="background:#EAF3EE;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#2A6B4A">
      📅 Buy by <strong>${buyByStr}</strong> — ${Object.keys(ingMap).length} items needed
    </div>
    ${groceryHTML}
  </div>` : ''}

  <h2 style="font-family:Georgia,serif;font-size:20px;font-weight:700;color:#1C1714;margin:0 0 16px">
    ${isWeek ? '🍽️ Your 5 Recipes' : '🍽️ Your Recipe'}
  </h2>
  ${recipesHTML}

  ${!isWeek ? `
  <div style="background:white;border:1px solid #EAE5DF;border-radius:16px;padding:20px;margin-bottom:24px">
    <h2 style="font-size:16px;font-weight:700;color:#1C1714;margin:0 0 12px">🛒 What to Buy</h2>
    ${groceryHTML}
  </div>` : ''}

  <div style="background:#1C1714;border-radius:16px;padding:28px;text-align:center;margin-bottom:24px">
    <div style="font-family:Georgia,serif;font-size:20px;color:white;margin-bottom:8px">Love your ${isWeek ? 'meal plan' : 'recipe'}?</div>
    <div style="font-size:13px;color:rgba(255,255,255,.65);margin-bottom:20px">Get unlimited spins, week planning, soup creator, and your pantry always ready — for less than one takeout order a month.</div>
    <a href="https://mealwheeliq.com/login.html" style="background:#C94B2A;color:white;text-decoration:none;border-radius:24px;padding:12px 28px;font-size:14px;font-weight:700;display:inline-block">Get unlimited spins — $4.99/mo →</a>
  </div>

  <div style="text-align:center;font-size:12px;color:#8C7B72;padding-bottom:24px">
    MealWheelIQ · Spin it. Cook it. Love it.<br>
    <a href="https://mealwheeliq.com" style="color:#C94B2A;text-decoration:none">mealwheeliq.com</a>
  </div>
</div>
</body></html>`;

  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM || 'chef@mealwheeliq.com',
      to: contact,
      subject,
      html
    });
    session.emailSent = true;
    quickspinSessions.set(token, session);
    res.json({ sent: true });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// GET /quickspin/session/:token — check session status
app.get('/quickspin/session/:token', (req, res) => {
  const session = quickspinSessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    paid: session.paid,
    mode: session.mode,
    generated: !!session.generated,
    mixupUsed: !!session.mixupUsed,
    emailSent: !!session.emailSent
  });
});

// Webhook handler — add quickspin payment handling
// (inserted into existing webhook handler via code)

// ─── START ───────────────────────────────────────────────────────────────────
async function startWithRetry(retries = 5, delayMs = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await connectDB();
      await createTables();
      app.listen(PORT, () => console.log(`MealsWheel API running on port ${PORT}`));
      return;
    } catch (err) {
      console.error(`Startup attempt ${i}/${retries} failed:`, err.message);
      if (i < retries) {
        console.log(`Retrying in ${delayMs/1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        console.error('All startup attempts failed. Exiting.');
        process.exit(1);
      }
    }
  }
}

startWithRetry();
