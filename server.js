// ─── RECIPE IMAGE GENERATION ─────────────────────────────────────────────────
// Image generation disabled — enable when OpenAI image models are available on account
// To re-enable: uncomment and add OPENAI_API_KEY with image generation permissions


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

    // Download DALL-E image and store permanently in GitHub (DALL-E URLs expire in ~1hr)
    let finalImgUrl = 'https://mealwheeliq.com/icons/icon-512.png';
    if (ghToken && imageUrl && imageUrl.startsWith('http')) {
      try {
        const imgBuf = await new Promise((resolve, reject) => {
          https.get(imageUrl, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
        });
        await ghPush(
          `og/img/${recipeId}.png`,
          imgBuf.toString('base64'),
          `img: recipe ${recipeId} photo`
        );
        finalImgUrl = `https://mealwheeliq.com/og/img/${recipeId}.png`;
        // Also update image_url in DB with permanent URL
        await db.execute('UPDATE recipe_history SET image_url = ? WHERE id = ?', [finalImgUrl, recipeId]);
        console.log('Permanent image URL saved:', finalImgUrl);
      } catch(e) {
        console.log('Image store error:', e.message);
      }
    }

    // Build OG HTML with permanent image URL
    const html = `<!DOCTYPE html>
<html prefix="og: http://ogp.me/ns#">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${finalImgUrl}">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="1024">
  <meta property="og:image:type" content="image/png">
  <meta property="og:url" content="${ogUrl}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="MealWheelIQ - AI Dinner Planning">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${finalImgUrl}">
  <link rel="canonical" href="${pageUrl}">
  <meta http-equiv="refresh" content="0;url=${pageUrl}">
</head>
<body>
  <h1>${r.recipe_name}</h1>
  <p>${desc}</p>
  <p><a href="${pageUrl}">View full recipe on MealWheelIQ</a></p>
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
