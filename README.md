# Secure Doc Share

A free, self-hosted way to share PDFs with **only the email IDs you allow**, in the spirit of Papermark or DocSend.

- **Email allow list.** Viewers sign in with Google or a magic link. The database only returns a document if the verified email is on that document's list.
- **Private storage.** Files sit in a private Supabase bucket. Each open gets a download link that expires in 60 seconds.
- **View-only reader.** PDF pages are drawn onto canvas with PDF.js. There is no download button, and copy, print and right-click are blocked.
- **Per-viewer watermark.** Every page carries the viewer's email and the time, drawn into the page pixels.
- **Screenshot deterrents.** The page blurs when the window loses focus or Print Screen or a screenshot shortcut is pressed. It also hides itself when printed.
- **Access controls.** You can disable a link, set an expiry date, or edit the allow list at any time.
- **View log.** See who opened each document and when.
- **Free to run.** GitHub Pages hosts the site and the Supabase free tier handles sign-in, the database and storage.

> **Honest limit:** no website can fully stop screenshots or someone pointing a phone camera at the screen. The watermark makes any leak traceable to the exact viewer, and that's the real protection.

## How it works

```
GitHub Pages (static site)          Supabase (free tier)
┌────────────────────────┐          ┌──────────────────────────────────┐
│ index.html  viewer     │──auth──▶ │ Auth: Google / email magic link  │
│ admin.html  owner      │──SQL───▶ │ Postgres + row level security    │
│ PDF.js canvas renderer │◀─60s URL─│ Private storage bucket "documents"│
└────────────────────────┘          └──────────────────────────────────┘
```

Every rule is enforced in the database (`supabase/schema.sql`), not in the browser:

| Table | Purpose |
|---|---|
| `admins` | Emails allowed to upload and manage documents |
| `documents` | Title, storage path, active flag, optional expiry |
| `document_access` | Allowed email IDs per document |
| `view_logs` | Who opened what, and when |

`can_view(doc)` is true only if the signed-in user's **verified** email is on the list, the document is active, and it hasn't expired. The same check guards the table rows and the storage files.

## Setup (about 15 minutes)

### 1. Create a Supabase project
1. Sign up at [supabase.com](https://supabase.com) and create a new project on the free plan.
2. Open **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, and click **Run**.
3. Make yourself the admin. Run this with your own email, in lowercase:
   ```sql
   insert into public.admins (email) values ('you@gmail.com');
   ```

### 2. Connect the site
1. In Supabase, go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
2. Paste them into `assets/config.js`. The anon key is meant to be public, because security comes from the database policies.

### 3. Allow sign-in redirects
In **Authentication → URL Configuration**:
- **Site URL:** `https://<your-username>.github.io/secure-doc-share/`
- **Redirect URLs:** add `https://<your-username>.github.io/secure-doc-share/**`

### 4. Turn on Google sign-in (recommended)
The built-in email sender on the free plan only sends a few emails per hour, so Google sign-in works better for groups.
1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), go to **Create credentials → OAuth client ID → Web application**.
2. Under **Authorized redirect URIs**, add `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Paste the client ID and secret into Supabase under **Authentication → Providers → Google**, and enable it.

### 5. Deploy on GitHub Pages
Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.

## Android-only viewing (blocks screenshots)

Viewers can only open documents in the **Secure Doc Share Android app** (`android/`). It's a small WebView app with Android's `FLAG_SECURE` switched on, so the phone refuses screenshots and screen recordings and hides the app in the recent-apps view.

- **Opening a link in a browser** shows an "Open in app" screen with an APK download. It does not open the document.
- **The database enforces it.** `supabase/002_android_only.sql` makes viewers call `start_view()` with the app key before storage will release a file. A browser has no key and is refused.
- **Automatic builds.** GitHub Actions (`.github/workflows/android.yml`) builds and signs the APK and publishes it as the latest release.

Setup:
1. Run `supabase/002_android_only.sql` in the SQL Editor, then insert your app key hash into `app_secrets`.
2. Add two repository secrets under **Settings → Secrets and variables → Actions**: `APP_KEY` and `KEYSTORE_BASE64`.
3. In Supabase, add `securedocshare://auth` under **Authentication → URL Configuration → Redirect URLs**.
4. Run **Actions → Build Android app → Run workflow**.

> The app key is hidden inside the APK, not truly secret. A determined developer could extract it, but ordinary viewers can't get past the app. iPhones are not supported.

## Using it
1. Open `…/secure-doc-share/admin.html` and sign in.
2. Upload a PDF and paste the allowed email IDs, separated by commas or new lines.
3. Copy the share link (`…/?doc=<id>`) and send it. Only listed emails can open it. Anyone else sees "No access".

## Free tier limits (Supabase)
The free plan gives 1 GB of file storage, 50 MB per file and 50,000 monthly active users. Projects pause after a week with no activity; you can restore one from the dashboard.

## Tech
Plain HTML, CSS and JavaScript with no build step. It uses [supabase-js](https://github.com/supabase/supabase-js) and [PDF.js](https://mozilla.github.io/pdf.js/) from a CDN.

## License
MIT
