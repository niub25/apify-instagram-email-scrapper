# 🏃 Instagram Running Influencer Email Extractor — Apify Actor

Finds Instagram accounts posting about **running, marathon, and halfmarathon**,
filters by minimum follower count (default: 50 000), and extracts **email addresses**
from their bios and linked websites.

---

## 📦 Output fields (per profile)

| Field          | Type       | Description                                      |
|----------------|------------|--------------------------------------------------|
| `username`     | String     | Instagram handle                                 |
| `fullName`     | String     | Display name                                     |
| `profileUrl`   | String     | Direct link to profile                           |
| `followers`    | Number     | Follower count                                   |
| `following`    | Number     | Following count                                  |
| `posts`        | Number     | Total posts                                      |
| `bio`          | String     | Full bio text                                    |
| `website`      | String     | External link in bio                             |
| `bioLinks`     | String     | Additional bio link URLs                         |
| `emails`       | String[]   | **All extracted email addresses**                |
| `hasEmail`     | Boolean    | True if at least one email was found             |
| `isVerified`   | Boolean    | Blue tick status                                 |
| `isPrivate`    | Boolean    | Account privacy setting                          |
| `profilePicUrl`| String     | Profile picture URL                              |
| `scrapedAt`    | ISO String | Timestamp of when this record was scraped        |

---

## ⚙️ Input parameters

### `hashtags` (Array of strings, default: 10 running-related tags)
Instagram hashtags to search. Do **not** include the `#` symbol.

### `minFollowers` (Integer, default: `50000`)
Minimum follower threshold. Profiles below this are skipped.

### `maxResults` (Integer, default: `200`)
Actor stops after saving this many qualifying profiles.

### `sessionId` (String, **strongly recommended**)
Your Instagram `sessionid` cookie value.

**How to get it:**
1. Log in to Instagram in Chrome/Firefox
2. Open DevTools → Application → Cookies → `https://www.instagram.com`
3. Copy the value of the `sessionid` cookie
4. Paste it into the actor input

Without a session ID, Instagram will aggressively block requests. Treat this value like a password — use Apify's **secret** field.

### `csrfToken` (String, optional)
Your Instagram `csrftoken` cookie value. Get it the same way as `sessionId`.

### `proxyConfiguration` (Object)
Defaults to **Apify Residential** proxies, which are strongly recommended for Instagram. You can also use your own proxy list.

---

## 🚀 Deployment to Apify

### Option A — Apify Console (easiest)
1. Go to [console.apify.com](https://console.apify.com) → **Actors** → **Create new**
2. Choose **"Link a Git repository"** → GitHub
3. Point to this repo
4. Click **Build**

### Option B — Apify CLI
```bash
npm install -g apify-cli
apify login
apify push
```

---

## ⚠️ Important notes

1. **Instagram rate limits** — Always use residential proxies and provide a `sessionId`. Without them, expect heavy blocking (HTTP 429 / 401 responses).
2. **Account risk** — Using your personal account's `sessionId` carries a small risk of a temporary block. Consider using a dedicated scraping account.
3. **Private accounts** — The actor skips private accounts for profile data.
4. **Email availability** — Many influencers put their email directly in their bio (e.g. `📧 hello@jane.com`). Others link to a website; the actor follows bio links to extract emails found there.
5. **Legal / ToS** — Scraping Instagram may violate their Terms of Service. Use this actor only for legitimate business outreach purposes and comply with GDPR / CAN-SPAM when using extracted emails.

---

## 📤 Exporting results

From the Apify dataset you can export to:
- **CSV** → open in Excel / Google Sheets
- **JSON** → pipe into your CRM or email tool
- **XLSX** → download directly

Filter the dataset by `hasEmail: true` to get only profiles with extractable emails.
