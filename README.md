# Task Tracker

A shared ticketing tool for a small team. Raise tasks, attach screenshots,
assign them to people, set priority, comment, mark done, and reopen.
Everyone signed in sees the same live board.

- **Frontend:** plain HTML, CSS, JavaScript. No build step.
- **Backend:** Supabase (free tier) for the database, login, and screenshot storage.

## What it does

- Sign in with email and password, or with an emailed sign-in link
- Invite people by email before they have an account
- Raise a ticket in seconds: paste a screenshot, write what needs doing, pick one or more assignees, and set priority
- Tickets assigned to an invited email automatically move to that person's account after they sign in
- The board shows each ticket as a card with the screenshot and text right on it, no clicking needed to see what it is
- Ticket creators can attach screenshots by paste (Ctrl/Cmd+V), drag and drop, or click to choose
- Filter the board by assignee (one click on "My tickets"), status, and priority, plus search
- Ticket creators and assignees can comment on a ticket
- Ticket creators and assignees can mark a ticket done or reopen it, with a required comment
- Live updates: when one person changes something, every open board refreshes

## One-time setup (about 10 minutes)

### 1. Create the Supabase project

1. Go to https://supabase.com and sign up (free).
2. Click **New project**. Give it a name and a database password. Wait for it to finish setting up.

### 2. Create the database

1. In your Supabase project, open **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Open `schema.sql` from this folder, copy everything, paste it in, and click **Run**.
   You should see "Success".
   If you already set up an older version, run the latest `schema.sql` again.
   It adds the invite fields without deleting existing tickets.

### 3. Turn off email confirmation (so signups work instantly)

1. In Supabase, go to **Authentication** > **Sign In / Providers** > **Email**.
2. Turn **off** "Confirm email", then save.
   (If you skip this, new users must click a link in their email before signing in.)

### 4. Allow invite links to return to the app

1. In Supabase, go to **Authentication** > **URL Configuration**.
2. Add your local URL, for example `http://localhost:5173`, to **Redirect URLs**.
3. After deployment, add your Netlify URL there too.

### 5. Connect the app to Supabase

1. In Supabase, go to **Project Settings** > **API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `config.js` in this folder and paste both values in. Save the file.
4. Set `APP_URL` to your deployed Vercel URL. This is what invite emails use
   when people click their sign-in links. Do not set this to `localhost`.

### 6. Try it locally

Open a terminal in this folder and run:

```
python3 -m http.server 5173
```

Then visit http://localhost:5173 in your browser. Create an account and raise a test ticket.

## Put it online for your team on Vercel

The whole `task-tracker` folder is a static site. It now includes
`vercel.json`, so Vercel can deploy it without a build step.

1. Put this folder in GitHub.
2. Go to Vercel and choose **Add New Project**.
3. Import the GitHub repository.
4. Use these settings:
   - **Framework Preset:** Other
   - **Build Command:** leave empty
   - **Output Directory:** `.`
5. Click **Deploy**.
6. Copy the Vercel production URL.
7. In Supabase, go to **Authentication** > **URL Configuration**.
8. Set **Site URL** to the Vercel URL.
9. Add the Vercel URL to **Redirect URLs**.

Each teammate can open the URL and create their own account with their name,
email, and a password. You can also click **Invite person** first, assign
tickets to their email, and Supabase will email them a sign-in link. Once they
sign in with the same email, those tickets appear under **My tickets**. Invited
people can use the emailed invite link immediately, and can use **Email me a
sign-in link** later if they do not create a password.

If users see **email rate limit exceeded**, Supabase has blocked auth emails
temporarily. Wait about an hour, or configure custom SMTP in Supabase
Authentication settings for reliable team invites.

Whenever you edit the app and push to GitHub, Vercel deploys the update.

## Good to know

- Everything here is free. Supabase and Netlify both have free tiers with no
  credit card needed. Supabase free gives 500 MB of database and 1 GB for
  screenshots, which is plenty for a small team.
- A free Supabase project pauses after 7 days with no activity. A team using
  it regularly never hits this. If it does pause, open the Supabase dashboard
  and click restore.
- The **anon key** in `config.js` is meant to be public. Your data is protected
  by database rules: only signed-in users can read tickets.
- Only the ticket creator can edit task details, assignees, screenshots, or
  delete the ticket. The creator and assignees can comment and update status.
- Screenshots are stored in a public Storage bucket, so anyone with a direct
  image link can view that image. Do not attach anything sensitive.
- To stop new people from signing up once your team has joined, go to
  **Authentication** > **Sign In / Providers** > **Email** and turn off
  "Allow new users to sign up".

## Files

| File | What it is |
|------|-----------|
| `index.html` | Page structure |
| `styles.css` | Styling |
| `app.js` | All app logic |
| `config.js` | Your Supabase URL and key (you fill this in) |
| `schema.sql` | Database setup, run once in Supabase |
| `README.md` | This file |
