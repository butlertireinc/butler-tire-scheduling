# Butler Tire Service Scheduling — Deployment Guide

Follow these steps in order. Takes about 20–30 minutes.

---

## Step 1 — Sign up for Upstash (free database)

1. Go to https://upstash.com and click **Sign Up**
2. Sign in with Google or create an account
3. Click **Create Database**
4. Name it: `butler-tire`
5. Type: **Redis**
6. Region: **US-East-1** (or whichever is closest to you)
7. Click **Create**
8. On the database page, scroll to **REST API**
9. Copy and save two values:
   - **UPSTASH_REDIS_REST_URL** (looks like `https://us1-xxx-xxx.upstash.io`)
   - **UPSTASH_REDIS_REST_TOKEN** (a long string of letters and numbers)

---

## Step 2 — Sign up for GitHub (free code hosting)

1. Go to https://github.com and click **Sign up**
2. Create a free account
3. Click **New repository** (the green button)
4. Name it: `butler-tire-scheduling`
5. Set to **Public**
6. Click **Create repository**
7. On the next page, click **uploading an existing file**
8. Drag and drop ALL the files from this folder into the upload area
   (Make sure to include the `src` folder and its contents)
9. Click **Commit changes**

---

## Step 3 — Deploy to Vercel (free hosting)

1. Go to https://vercel.com and click **Sign Up**
2. Sign in with **GitHub** (this connects your code automatically)
3. Click **Add New Project**
4. Find and select your `butler-tire-scheduling` repository
5. Click **Import**
6. Before clicking Deploy, click **Environment Variables** and add:

   | Name | Value |
   |------|-------|
   | `VITE_UPSTASH_URL` | (paste your Upstash REST URL from Step 1) |
   | `VITE_UPSTASH_TOKEN` | (paste your Upstash REST Token from Step 1) |

7. Click **Deploy**
8. Wait about 60 seconds — Vercel will give you a URL like `butler-tire-scheduling.vercel.app`

---

## Step 4 — Add the booking button to your website

Give this code to whoever manages your website, or paste it into your site's HTML editor:

```html
<a href="https://YOUR-APP-URL.vercel.app" target="_blank"
   style="background:#003DA5; color:white; padding:14px 28px;
          border-radius:8px; font-weight:bold; text-decoration:none;
          display:inline-block; font-family:sans-serif; font-size:16px;">
  Book an Appointment
</a>
```

Replace `YOUR-APP-URL` with your actual Vercel URL from Step 3.

---

## Step 5 — Set your admin password

1. Open your live site URL
2. Click **Admin**
3. Enter the default password: **1234**
4. Go to **Settings → Admin Security**
5. Change the password to something strong

---

## You're live!

Your booking system is now:
- Accessible at your Vercel URL
- Synced across all devices (phone, tablet, shop computer)
- Ready to link from your existing website
