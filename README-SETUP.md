# Sprinkler Planner v8 – Cloud Login Setup

## What this version adds
1. Sign in with Email (magic link) or Google
2. Projects sync across all your devices once signed in
3. Export / Import still works as a backup
4. Database ready for true “share with a partner” later

## One-time setup (≈10 minutes)

### 1. Create a free Supabase project
1. Go to https://supabase.com and sign up / log in
2. Click **New project**
3. Choose a name (e.g. “sprinkler-planner”), set a database password, pick a region close to you
4. Wait for the project to finish provisioning

### 2. Run the database setup
1. In the left sidebar click **SQL Editor**
2. Click **New query**
3. Copy the entire contents of `supabase-setup.sql` and paste it
4. Click **Run**

### 3. Enable authentication providers
1. Go to **Authentication → Providers**
2. Turn **Email** on (it is usually on by already)
3. (Optional but recommended) Turn **Google** on  
   - You will need a Google Cloud OAuth client ID + secret  
   - Supabase shows you the exact redirect URL to paste into Google

### 4. Get your keys
1. Go to **Project Settings → API**
2. Copy:
   - **Project URL**
   - **anon public** key

### 5. Put the keys into the app
Open `app.js` and find these two lines near the top:

```js
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';
```

Paste your values:

```js
const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

### 6. Deploy
Upload the new `app.js`, `index.html`, and keep your existing `styles.css`, `manifest.webmanifest`, etc.

### 7. Auth redirect URL
In Supabase → Authentication → URL Configuration  
Add your GitHub Pages URL (e.g. `https://yourusername.github.io/sprinkler-planner/`) to the **Site URL** and **Redirect URLs**.

---

## How it behaves

| Situation                        | Behavior                                      |
|----------------------------------|-----------------------------------------------|
| No keys filled in                | Works exactly like before (localStorage only) |
| Keys filled in, not signed in    | Local mode + Sign-in button appears           |
| Signed in                        | Projects load from / save to the cloud        |
| Export / Import                  | Always available as a backup                  |

You never have to look at user data. Supabase just stores the projects for whoever is signed in.
