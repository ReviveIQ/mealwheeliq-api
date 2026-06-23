# mealswheel-api

Express.js backend for MealWheelIQ — deployed on Railway at `api.mealwheeliq.com`.

## Health Check

```
GET https://api.mealwheeliq.com/
→ { "status": "MealsWheel API running 🍽️" }
```

## Stack

- **Runtime:** Node.js on Railway
- **Database:** TiDB Cloud Serverless (`mealwheeliq` schema)
- **AI:** Anthropic claude-sonnet-4-6
- **Auth:** JWT + bcrypt
- **Payments:** Stripe (live mode)
- **Nutrition:** USDA FoodData Central

## Environment Variables (Railway)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `TIDB_HOST` | TiDB cluster host |
| `TIDB_PORT` | TiDB port (4000) |
| `TIDB_USER` | TiDB username |
| `TIDB_PASSWORD` | TiDB password |
| `TIDB_DATABASE` | `mealwheeliq` |
| `JWT_SECRET` | Long random string for token signing |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `STRIPE_TRIAL_PRICE_ID` | Weekly trial price ID |
| `STRIPE_HOME_CHEF_PRICE_ID` | Home Chef monthly price ID |
| `STRIPE_FAMILY_PRICE_ID` | Family monthly price ID |
| `USDA_API_KEY` | FoodData Central API key |

## Key Routes

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/` | None | Health check |
| POST | `/auth/signup` | None | Create account |
| POST | `/auth/login` | None | Login, returns JWT |
| GET | `/auth/me` | JWT | Current user + plan + spin count |
| GET | `/preferences` | JWT | Calorie goal, servings, diet prefs, chef name |
| PUT | `/preferences` | JWT | Save preferences incl. chef name |
| GET | `/pantry` | JWT | User's saved pantry ingredients |
| POST | `/pantry` | JWT | Replace entire pantry |
| POST | `/generate` | JWT | Generate recipes (checks spin limit) |
| GET | `/history` | JWT | Recipe history (empty for free users) |
| POST | `/recipes/:id/rate` | JWT | Rate a recipe 1–5 stars |
| GET | `/top-recipes` | None | Public — top rated recipes for landing page |
| POST | `/favorites/:id` | JWT | Add to favorites |
| DELETE | `/favorites/:id` | JWT | Remove from favorites |
| GET | `/favorites` | JWT | All favorites |
| GET | `/mealplans` | JWT | Saved meal plans |
| POST | `/mealplans` | JWT | Save meal plan |
| POST | `/subscribe` | JWT | Create Stripe checkout session |
| POST | `/webhook` | Stripe | Handle payment events |

## Database Tables (auto-created on boot)

`users`, `subscriptions`, `user_preferences`, `user_pantry`, `recipe_history`, `recipe_ratings`, `favorite_recipes`, `meal_plans`, `meal_plan_items`, `spin_counts`, `family_profiles`

## Deployment

Push to `main` → Railway auto-deploys in ~2 minutes. Server retries DB connection up to 5 times on startup (handles TiDB cold wake).
