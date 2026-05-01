# RESTO PRO - Render Free + Supabase PostgreSQL

This version stores restaurant data in Supabase PostgreSQL instead of a local JSON file.
It is designed for Render Free Web Service + Supabase Free database.

## Required Render environment variables

```text
NODE_VERSION=20
NODE_ENV=production
JWT_SECRET=<long random secret>
DATABASE_URL=<Supabase Transaction Pooler connection string>
OCR_ENABLED=true
```

Do not add DATA_DIR, DATA_FILE, or UPLOAD_DIR. They are not needed in this version.

## Use Supabase Transaction Pooler

In Supabase:

1. Project dashboard → Connect
2. Choose Direct tab
3. Under Connection Method, select Transaction pooler
4. Copy the URI connection string
5. Replace `[YOUR-PASSWORD]` with your database password
6. Paste it in Render as `DATABASE_URL`

The URL usually looks like:

```text
postgresql://postgres.PROJECT_REF:YOUR_PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

## Deploy on Render

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

## Default login

```text
Email: owner@resto.com
Password: owner123
```

Change the password immediately after first login.

## Data location

All main app data is stored in Supabase table:

```text
app_state
```

This backend creates the table automatically on first startup.
