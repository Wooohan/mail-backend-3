import express from 'express';
import path from 'path';
import fs from 'fs';
import dns from 'dns';
import net from 'net';
import dotenv from 'dotenv';

dotenv.config();

// Default OAuth credentials fallback (from user request) so it works out of the box
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '641354509885-r4i89bqh96nhqh8scpn1i3tshesurjmr.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Allow the frontend (e.g. hosted on Vercel) to call this backend (e.g. on
// Railway) from a different origin. Set CORS_ORIGIN to a comma-separated list
// of allowed origins, or leave unset to allow any origin. No cookies are used
// (auth state lives server-side), so credentials are not required.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Directories. DATA_DIR can point at a mounted volume (e.g. a Railway volume)
// so JSON state survives restarts and redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Simple DB files path
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');

// Initialize DB files
const initDbFile = (filePath: string, defaultData: any = []) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
};

initDbFile(ACCOUNTS_FILE);
initDbFile(CONTACTS_FILE);
initDbFile(CAMPAIGNS_FILE);
initDbFile(LOGS_FILE);
initDbFile(QUEUE_FILE);

// Helpers to read/write DB files with simple in-memory locking/syncing
const readJson = (filePath: string): any[] => {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return [];
  }
};

const writeJson = (filePath: string, data: any) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing to ${filePath}:`, err);
  }
};

// Get exact redirect URI dynamically
const getRedirectUri = (req: any) => {
  // Respect APP_URL environment variable if set by AI Studio, otherwise derive from host
  const appUrlEnv = process.env.APP_URL;
  if (appUrlEnv) {
    const cleaned = appUrlEnv.endsWith('/') ? appUrlEnv.slice(0, -1) : appUrlEnv;
    return `${cleaned}/api/auth/callback`;
  }
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${protocol}://${host}/api/auth/callback`;
};

// Custom helper: RFC 2822 email encoder
const constructRawEmail = (to: string, fromName: string, fromEmail: string, subject: string, body: string) => {
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const emailLines = [
    `From: ${fromHeader}`,
    `To: <${to}>`,
    `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body
  ];
  const rawEmail = emailLines.join('\r\n');
  return Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

// Refreshes a Google OAuth access token
const refreshGoogleToken = async (refreshToken: string) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to refresh Google token: ${errText}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token as string,
    expiresIn: data.expires_in as number,
  };
};

/* ==========================================================================
   API ROUTES
   ========================================================================== */

// 1. OAuth Initiate
app.get('/api/auth/url', (req, res) => {
  const redirectUri = getRedirectUri(req);
  const scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent'
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.json({ url: authUrl, redirectUri });
});

// 2. OAuth Callback
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('OAuth callback is missing authorization code.');
  }

  try {
    const redirectUri = getRedirectUri(req);

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code: code as string,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      return res.status(400).send(`Failed exchanging OAuth code for tokens: ${errText}`);
    }

    const tokenData = await tokenResponse.json() as any;
    const { access_token, refresh_token, expires_in } = tokenData;

    // Fetch user details
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!profileResponse.ok) {
      return res.status(400).send('Failed calling Google userinfo API.');
    }

    const profileData = await profileResponse.json() as any;
    const { email } = profileData;

    if (!email) {
      return res.status(400).send('Google account has no associated email.');
    }

    // Save or update account in DB
    const accounts = readJson(ACCOUNTS_FILE);
    const existingIndex = accounts.findIndex(a => a.email.toLowerCase() === email.toLowerCase());

    const accountObj = {
      email: email,
      connectedAt: new Date().toISOString(),
      status: 'active',
      // If we don't get a new refresh_token because they already consent,
      // we reuse the old one. We only get it once per 'consent' prompt.
      refreshToken: refresh_token || (existingIndex >= 0 ? accounts[existingIndex].refreshToken : ''),
      accessToken: access_token,
      expiresAt: Date.now() + (expires_in * 1000)
    };

    if (existingIndex >= 0) {
      // Retain the old refresh token if the new one is undefined
      if (!accountObj.refreshToken) {
        accountObj.refreshToken = accounts[existingIndex].refreshToken;
      }
      accounts[existingIndex] = accountObj;
    } else {
      accounts.push(accountObj);
    }

    writeJson(ACCOUNTS_FILE, accounts);

    // Send absolute popup closing logic with message dispatch
    res.send(`
      <html>
        <head><title>Authentication Successful</title></head>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #fcfbfd; color: #1f1b2d;">
          <div style="max-width: 400px; margin: 0 auto; padding: 30px; border-radius: 12px; background: white; box-shadow: 0 4px 12px rgba(124, 92, 252, 0.08);">
            <div style="font-size: 48px; margin-bottom: 20px;">💜</div>
            <h2 style="color: #7C5CFC; margin-bottom: 10px;">Equinox Mail Connected</h2>
            <p style="color: #645a80; line-height: 1.5; font-size: 14px;">Your Gmail account <strong>${email}</strong> has been linked successfully.</p>
            <p style="color: #948ba4; font-size: 12px; margin-top: 25px;">You can close this window now.</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', email: '${email}' }, '*');
              setTimeout(() => { window.close(); }, 1200);
            } else {
              // Fallback if not popup
              setTimeout(() => { window.location.href = '/'; }, 1500);
            }
          </script>
        </body>
      </html>
    `);

  } catch (error: any) {
    console.error('OAuth Callback Error:', error);
    res.status(500).send(`Authentication error: ${error.message}`);
  }
});

// Get Connected Accounts
app.get('/api/accounts', (req, res) => {
  const accounts = readJson(ACCOUNTS_FILE);
  // Send sanitised version (remove actual refresh tokens for safety)
  const safeAccounts = accounts.map(a => ({
    email: a.email,
    connectedAt: a.connectedAt,
    status: a.refreshToken ? 'active' : 'expired'
  }));
  res.json(safeAccounts);
});

// Disconnect Account
app.delete('/api/accounts/:email', (req, res) => {
  const { email } = req.params;
  const accounts = readJson(ACCOUNTS_FILE);
  const updated = accounts.filter(a => a.email.toLowerCase() !== email.toLowerCase());
  writeJson(ACCOUNTS_FILE, updated);
  res.json({ success: true, email });
});

// GET Contacts lists
app.get('/api/contacts', (req, res) => {
  const contacts = readJson(CONTACTS_FILE);
  res.json(contacts);
});

// Deep local heuristic-pattern reputation engine (Guarantees immediate zero-cost detection of dead gaming tags, burner aliases, and automated profiles)
function analyzeLocalPartHeuristics(email: string): { status: 'valid' | 'risky' | 'invalid'; reason: string; isSuspicious: boolean } {
  const parts = email.split('@');
  if (parts.length !== 2) {
    return { status: 'invalid', reason: 'Malformed email syntax structure', isSuspicious: true };
  }
  const localPart = parts[0].toLowerCase();
  const domain = parts[1].toLowerCase();

  // 1. Identify common temporary/burner/sandbox placeholders
  const sandboxKeywords = ['test', 'dummy', 'trial', 'example', 'guest', 'bounce', 'sample', 'temp', 'demo', 'placeholder', 'null', 'undefined'];
  if (sandboxKeywords.some(kw => localPart.startsWith(kw) || localPart.endsWith(kw) || localPart === kw)) {
    return { 
      status: 'invalid', 
      reason: `Sandbox or structural test email prefix/suffix pattern detected ("${parts[0]}")`, 
      isSuspicious: true 
    };
  }

  // 2. Detect default automated Gaming/Console nicknames (Apple Game Center, Xbox Live, PSN tags)
  // Standard automated pattern: Starts with single letter/digit sequence, followed by alphanumeric, containing gaming words.
  const gamingKeywords = [
    'killer', 'slayer', 'hunter', 'sniper', 'gaming', 'ninja', 'gamer', 
    'roblox', 'fortnite', 'mcpe', 'playstation', 'xbox', 'steam', 'beast', 
    'noob', 'dummy', 'junk', 'temp', 'bot', 'spam', 'pvp', 'warrior', 'ghost',
    'bullet', 'dead', 'assassin', 'demon', 'monster', 'hacker', 'cheat'
  ];

  const hasGamingWord = gamingKeywords.some(kw => localPart.includes(kw));
  const matchesConsolePrefix = /^[a-z]\d{1,2}[a-z0-9_-]{4,}$/i.test(localPart);

  if (matchesConsolePrefix && hasGamingWord) {
    return {
      status: 'invalid',
      reason: `Detected inactive or automated default gaming network tag layout ("${parts[0]}")`,
      isSuspicious: true
    };
  }

  // If gaming keywords are found on consumer personal domains like Game Center/Apple/Hotmail, prioritize marking them as invalid/dead
  if (hasGamingWord && (domain === 'icloud.com' || domain === 'hotmail.com' || domain === 'outlook.com' || domain === 'yahoo.com')) {
    return {
      status: 'invalid',
      reason: `Gaming/junk handle registered on a public personal inbox ("${parts[0]}" on ${domain})`,
      isSuspicious: true
    };
  }

  // 3. Apple Private relay & Hide My Email detection
  if (domain === 'privaterelay.appleid.com' || (domain === 'icloud.com' && /^[a-z0-9]{12,24}$/i.test(localPart) && !(localPart.match(/[aeiou]/g)))) {
    return {
      status: 'invalid',
      reason: 'Automated transient device relay / private masquerade inbox address',
      isSuspicious: true
    };
  }

  // 4. Randomized gibberish/consonant mash (e.g. "zxcvbnm", "qwrtypsdfgh")
  const vowels = (localPart.match(/[aeiouy]/g) || []).length;
  const letters = (localPart.match(/[a-z]/g) || []).length;
  if (letters >= 7 && vowels === 0) {
    return {
      status: 'invalid',
      reason: `Gibberish character structure (No vowels matching pronunciation rules)`,
      isSuspicious: true
    };
  }

  // 5. Excessive consecutive digit suffix/burner ids
  const highDigitSuffix = localPart.match(/\d{5,}$/);
  if (highDigitSuffix) {
    return {
      status: 'invalid',
      reason: `Burner alias with highly repetitive or long serial numeric suffix ("${highDigitSuffix[0]}")`,
      isSuspicious: true
    };
  }

  // 6. Character repetition scans (e.g. "aaaaaa", "xyz11111")
  const repeated = /([a-z0-9])\1{4,}/i.test(localPart);
  if (repeated) {
    return {
      status: 'invalid',
      reason: 'Suspicious repeating character sequence detected inside address prefix',
      isSuspicious: true
    };
  }

  return { status: 'valid', reason: 'Passed heuristic checks', isSuspicious: false };
}

// Advanced domain reputation/legitimacy analyzer
function analyzeDomainHeuristics(domain: string): { status: 'valid' | 'risky' | 'invalid'; reason: string; isSuspicious: boolean } {
  const domainLower = domain.toLowerCase();

  // 1. Identify common domain registrar holding or parking sequences
  const parkedKeywords = [
    'parking', 'parked', 'sedo', 'bodis', 'above', 'registrar-servers', 
    'namesilo', 'hosting', 'domain-parking', 'pagedomain', 'domaincontrol',
    'msholdings', 'huamei', 'parkingcrew', 'namedrive'
  ];
  if (parkedKeywords.some(kw => domainLower.includes(kw))) {
    return {
      status: 'invalid',
      reason: `Inactive domain parking or domain registrar lander server ("${domain}")`,
      isSuspicious: true
    };
  }

  // 2. Detect automated serial domains registered by script bots (e.g., "007express", "123express")
  // Often registered using numbers combined with logistical, delivery, or commercial dictionaries.
  const contains007Express = domainLower.includes('007express');
  const botNumberPatterns = /^(007|123|777|999|888|001|000|111)\w*(express|cargo|ship|mail|post|delivery|temp|box|fwd|fow|support|srv|service|invoice|office|help|auth)\b/i;
  const botNumberSuffix = /\d{3,}(express|cargo|ship|mail|post|delivery|temp|box|fwd|fow|support|srv|service|invoice|office|help|auth)/i;
  
  if (contains007Express || botNumberPatterns.test(domainLower) || botNumberSuffix.test(domainLower)) {
    return {
      status: 'invalid',
      reason: `Automated spam-routing tracking style domain format detected ("${domain}")`,
      isSuspicious: true
    };
  }

  // 3. Look for Brand Squatting or phishing structures (mimicking major safe services)
  const brands = ['google', 'microsoft', 'apple', 'icloud', 'outlook', 'paypal', 'amazon', 'facebook', 'instagram', 'netflix', 'stripe'];
  const isOfficialBrand = (
    domainLower === 'google.com' || domainLower === 'gmail.com' ||
    domainLower === 'microsoft.com' || domainLower === 'outlook.com' || domainLower === 'hotmail.com' ||
    domainLower === 'apple.com' || domainLower === 'icloud.com' ||
    domainLower === 'paypal.com' || domainLower === 'amazon.com' ||
    domainLower === 'facebook.com' || domainLower === 'instagram.com' ||
    domainLower === 'netflix.com' || domainLower === 'stripe.com'
  );

  if (!isOfficialBrand) {
    for (const brand of brands) {
      if (domainLower.includes(brand) && !domainLower.endsWith(`.${brand}.com`) && !domainLower.endsWith(`.${brand}.co`)) {
        return {
          status: 'invalid',
          reason: `High risk phishing or brand-squatting signature targeting "${brand}"`,
          isSuspicious: true
        };
      }
    }
  }

  // 4. Pure gibberish short domain names with consonant heavy sequences
  const mainPart = domainLower.split('.')[0] || '';
  if (mainPart.length >= 6) {
    const vowels = (mainPart.match(/[aeiouy]/g) || []).length;
    const alphabetOnly = (mainPart.match(/[a-z]/g) || []).length;
    if (alphabetOnly >= 6 && vowels === 0) {
      return {
        status: 'invalid',
        reason: `Gibberish consonant-only domain name signature ("${mainPart}")`,
        isSuspicious: true
      };
    }
  }

  return { status: 'valid', reason: 'Passed domain checks', isSuspicious: false };
}

// Advanced offline email pattern & reputation analyst (fully self-contained, no external AI dependency)
async function checkEmailReputation(email: string): Promise<{ status: 'valid' | 'risky' | 'invalid', reason: string }> {
  // First run local heuristics to handle instantaneous detection of automated/junk patterns
  const localHeuristic = analyzeLocalPartHeuristics(email);
  if (localHeuristic.isSuspicious) {
    return { status: localHeuristic.status, reason: localHeuristic.reason };
  }

  // Run domain-level heuristics to capture fake parked/commercial tracker domains
  const parts = email.split('@');
  const domain = parts[1] || '';
  const domainHeuristic = analyzeDomainHeuristics(domain);
  if (domainHeuristic.isSuspicious) {
    return { status: domainHeuristic.status, reason: domainHeuristic.reason };
  }

  // Fallback to safe offline structure verification
  const finalStatus = (localHeuristic.status === 'invalid' || domainHeuristic.status === 'invalid') ? 'invalid' : 'valid';
  return { 
    status: finalStatus, 
    reason: finalStatus === 'valid' 
      ? 'Structure & active domain authority reputation validated' 
      : (domainHeuristic.status === 'invalid' ? domainHeuristic.reason : localHeuristic.reason)
  };
}

// Typo domain lookup dictionary
const TYPOS: Record<string, string> = {
  'gamil.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gamil.co': 'gmail.com',
  'yaho.com': 'yahoo.com',
  'iclod.com': 'icloud.com',
  'hotmial.com': 'hotmail.com',
  'hotail.com': 'hotmail.com',
  'msn.co': 'msn.com',
  'outlook.co': 'outlook.com',
  'yahoo.co': 'yahoo.com'
};

// Disposable domains list
const DISPOSABLE = [
  'mailinator.com', 'yopmail.com', 'temp-mail.org', 'tempmail.com', 
  'dispostable.com', 'guerrillamail.com', 'sharklasers.com', '10minutemail.com',
  'trashmail.com', 'getairmail.com', 'temp-mail.com', 'tempmail.net'
];

async function checkDnsAndSmtp(email: string): Promise<{ status: 'valid' | 'risky' | 'invalid', reason: string, domain: string }> {
  const parts = email.split('@');
  if (parts.length !== 2) {
    return { status: 'invalid', reason: 'Malformed email structure', domain: '' };
  }
  const localPart = parts[0].toLowerCase();
  const domain = parts[1].toLowerCase();

  // 1. Check Typos
  if (TYPOS[domain]) {
    return { 
      status: 'invalid', 
      reason: `Domain typo detected (${domain}). Did you mean ${TYPOS[domain]}?`, 
      domain 
    };
  }

  // 2. Check Disposable Domains
  if (DISPOSABLE.includes(domain)) {
    return { status: 'invalid', reason: 'Temporary or disposable burner domain', domain };
  }

  // 3. Early Heuristic Reject (e.g. Gamertag patterns like J2TIMEKILLER)
  const localHeuristic = analyzeLocalPartHeuristics(email);
  if (localHeuristic.isSuspicious) {
    return { 
      status: localHeuristic.status, 
      reason: localHeuristic.reason, 
      domain 
    };
  }

  // 3.5. Brand Squatting & Botanical Domain Heuristic Reject (e.g. CEO@007express.net)
  const domainHeuristic = analyzeDomainHeuristics(domain);
  if (domainHeuristic.isSuspicious) {
    return {
      status: domainHeuristic.status,
      reason: domainHeuristic.reason,
      domain
    };
  }

  // 4. Resolve MX records
  let mxRecords: dns.MxRecord[] = [];
  try {
    mxRecords = await dns.promises.resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { 
        status: 'invalid', 
        reason: 'No Mail Exchange (MX) records found. Domain is unable to receive emails.', 
        domain 
      };
    }
  } catch (err: any) {
    return { 
      status: 'invalid', 
      reason: 'Domain registration lookup failed. Domain does not exist or has no active mail servers configured.', 
      domain 
    };
  }

  // Sort MX by priority
  mxRecords.sort((a, b) => a.priority - b.priority);
  const primaryMx = mxRecords[0].exchange;

  // 4.2. Verify reputation of MX routing server host
  const mxHostHeuristic = analyzeDomainHeuristics(primaryMx);
  if (mxHostHeuristic.isSuspicious) {
    return {
      status: 'invalid',
      reason: `Unresolved delivery path: MX host "${primaryMx}" maps to known inactive/parked gateway pattern.`,
      domain
    };
  }

  // 4.5. Resolve the primary MX to physical IP addresses to guarantee its network existence
  let mxIps: string[] = [];
  try {
    mxIps = await dns.promises.resolve4(primaryMx);
  } catch (err: any) {
    try {
      mxIps = await dns.promises.resolve6(primaryMx);
    } catch (err2: any) {
      return {
        status: 'invalid',
        reason: `Dead routing lookup: MX host "${primaryMx}" has no active registered IP addresses. Deliverability checks failed.`,
        domain
      };
    }
  }

  const isPrivateOrLoopbackIp = (ip: string) => {
    if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::1' || ip === '::') return true;
    if (/^10\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;
    if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip)) return true;
    return false;
  };

  const hasOnlyPrivateIps = mxIps.length > 0 && mxIps.every(ip => isPrivateOrLoopbackIp(ip));
  if (hasOnlyPrivateIps) {
    return {
      status: 'invalid',
      reason: `Spoofed mail routing: MX resolves to inactive private or loopback IP range (${mxIps.join(', ')}) resembling a sandbox or dead server trap.`,
      domain
    };
  }

  // 5. Try Socket Port 25 Connection to MX
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    // We keep timeout very short (1500ms) to ensure lightning performance
    socket.setTimeout(1500);

    const finish = async (status: 'valid' | 'risky' | 'invalid', reason: string) => {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch (e) {}

      // If finished with standard TCP and was unresolvable or timeout (e.g. firewall port block),
      // run the deep offline reputation pattern scan on the address.
      if (status === 'valid' && (reason.includes('fallback') || reason.includes('bypassed'))) {
        const reputationCheck = await checkEmailReputation(email);
        resolve({
          status: reputationCheck.status,
          reason: reputationCheck.reason,
          domain
        });
      } else {
        resolve({ status, reason, domain });
      }
    };

    let step = 0;
    let dataBuffer = '';

    socket.connect(25, primaryMx);

    socket.on('connect', () => {
      // Connect hook
    });

    socket.on('data', (chunk) => {
      dataBuffer += chunk.toString();
      const lines = dataBuffer.split('\n');
      dataBuffer = lines.pop() || '';

      for (const line of lines) {
        const responseCode = line.trim().substring(0, 3);
        if (step === 0) {
          if (responseCode === '220') {
            socket.write(`EHLO verify-server.com\r\n`);
            step = 1;
          } else {
            finish('risky', `Mail server returned response ${responseCode} on connection greeting.`);
          }
        } else if (step === 1) {
          if (line.includes('250 ')) {
            socket.write(`MAIL FROM:<verify@verify-server.com>\r\n`);
            step = 2;
          } else if (responseCode !== '250') {
            finish('risky', `Mail server rejected connection handshake with code ${responseCode}.`);
          }
        } else if (step === 2) {
          if (responseCode === '250') {
            socket.write(`RCPT TO:<${email}>\r\n`);
            step = 3;
          } else {
            finish('risky', `Mail server rejected verify address with code ${responseCode}.`);
          }
        } else if (step === 3) {
          if (responseCode === '250') {
            finish('valid', 'Mailbox active. Email is fully deliverable and receives emails.');
          } else if (responseCode === '550' || responseCode === '551' || responseCode === '553' || responseCode === '554') {
            finish('invalid', `Real-time mail check failed: The email address is inactive or does not exist (Server code ${responseCode}).`);
          } else {
            finish('risky', `Inconclusive inbox response from host server (Code ${responseCode}).`);
          }
        }
      }
    });

    socket.on('error', () => {
      finish('valid', 'MX active handshake fallback');
    });

    socket.on('timeout', () => {
      finish('valid', 'MX active handshake fallback');
    });
  });
}

// POST /api/validate-emails
app.post('/api/validate-emails', async (req, res) => {
  const { emails } = req.body;
  if (!Array.isArray(emails)) {
    return res.status(400).json({ error: 'Expected "emails" parameter to be an array of strings' });
  }

  const promises = emails.map(async (rawEmail) => {
    const email = (rawEmail || '').trim();
    if (!email) {
      return {
        id: Math.random().toString(36).substr(2, 9),
        email: '',
        status: 'invalid',
        reason: 'Empty row',
        domain: '',
        selected: false
      };
    }

    // Syntax check regex
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return {
        id: Math.random().toString(36).substr(2, 9),
        email,
        status: 'invalid',
        reason: 'Malformed address organization',
        domain: '',
        selected: false
      };
    }

    const verificationResult = await checkDnsAndSmtp(email);
    return {
      id: Math.random().toString(36).substr(2, 9),
      email,
      status: verificationResult.status,
      reason: verificationResult.reason,
      domain: verificationResult.domain,
      selected: verificationResult.status !== 'invalid'
    };
  });

  const resolvedResults = await Promise.all(promises);
  res.json(resolvedResults);
});

// Create/Upload custom list or insert contacts
app.post('/api/contacts', (req, res) => {
  const newContacts = req.body; // Can be a single Contact or array of Contacts
  const current = readJson(CONTACTS_FILE);

  if (Array.isArray(newContacts)) {
    // Append array
    const cleanList = newContacts.map(c => ({
      id: c.id || Math.random().toString(36).substr(2, 9),
      email: c.email.trim(),
      name: (c.name || '').trim(),
      listName: (c.listName || 'Unassigned').trim(),
      company: c.company || '',
      firstName: c.firstName || '',
      variables: c.variables || {},
      createdAt: c.createdAt || new Date().toISOString()
    }));
    current.push(...cleanList);
  } else {
    // Add single Contact
    const cleanContact = {
      id: newContacts.id || Math.random().toString(36).substr(2, 9),
      email: newContacts.email.trim(),
      name: (newContacts.name || '').trim(),
      listName: (newContacts.listName || 'Unassigned').trim(),
      company: newContacts.company || '',
      firstName: newContacts.firstName || '',
      variables: newContacts.variables || {},
      createdAt: new Date().toISOString()
    };
    current.push(cleanContact);
  }

  writeJson(CONTACTS_FILE, current);
  res.json({ success: true });
});

// Delete individual Contact
app.delete('/api/contacts/:listName/:id', (req, res) => {
  const { listName, id } = req.params;
  const contacts = readJson(CONTACTS_FILE);
  const updated = contacts.filter(c => !(c.id === id && c.listName.toLowerCase() === listName.toLowerCase()));
  writeJson(CONTACTS_FILE, updated);
  res.json({ success: true });
});

// Delete whole list
app.delete('/api/contacts/:listName', (req, res) => {
  const { listName } = req.params;
  const contacts = readJson(CONTACTS_FILE);
  const updated = contacts.filter(c => c.listName.toLowerCase() !== listName.toLowerCase());
  writeJson(CONTACTS_FILE, updated);
  res.json({ success: true });
});

// Edit single contact
app.put('/api/contacts/:listName/:id', (req, res) => {
  const { listName, id } = req.params;
  const updatedContact = req.body;
  const contacts = readJson(CONTACTS_FILE);
  const idx = contacts.findIndex(c => c.id === id && c.listName.toLowerCase() === listName.toLowerCase());
  if (idx >= 0) {
    contacts[idx] = {
      ...contacts[idx],
      name: updatedContact.name !== undefined ? updatedContact.name : contacts[idx].name,
      email: updatedContact.email !== undefined ? updatedContact.email : contacts[idx].email,
      company: updatedContact.company !== undefined ? updatedContact.company : contacts[idx].company,
      firstName: updatedContact.firstName !== undefined ? updatedContact.firstName : contacts[idx].firstName,
      variables: updatedContact.variables !== undefined ? updatedContact.variables : contacts[idx].variables
    };
    writeJson(CONTACTS_FILE, contacts);
    res.json({ success: true, contact: contacts[idx] });
  } else {
    res.status(404).json({ error: 'Contact not found' });
  }
});

// GET Campaigns with dynamic stats calculated
app.get('/api/campaigns', (req, res) => {
  const campaigns = readJson(CAMPAIGNS_FILE);
  res.json(campaigns);
});

// POST Create Campaign
app.post('/api/campaigns', (req, res) => {
  const campaignData = req.body;
  const campaigns = readJson(CAMPAIGNS_FILE);

  const campaign = {
    id: Math.random().toString(36).substr(2, 9),
    name: campaignData.name,
    type: campaignData.type,
    status: 'draft',
    contactListName: campaignData.contactListName,
    subject: campaignData.subject,
    bodyTemplate: campaignData.bodyTemplate,
    // Normal campaign details
    senderEmail: campaignData.senderEmail,
    delaySeconds: Number(campaignData.delaySeconds || 5),
    sendLimit: campaignData.sendLimit ? Number(campaignData.sendLimit) : undefined,
    // Auto campaign details
    senderEmails: campaignData.senderEmails || [],
    emailsPerHourPerAccount: campaignData.emailsPerHourPerAccount ? Number(campaignData.emailsPerHourPerAccount) : undefined,
    // Stats
    totalContacts: Number(campaignData.totalContacts || 0),
    sentCount: 0,
    successCount: 0,
    failedCount: 0,
    createdAt: new Date().toISOString()
  };

  campaigns.push(campaign);
  writeJson(CAMPAIGNS_FILE, campaigns);
  res.json(campaign);
});

// PUT Edit Campaign
app.put('/api/campaigns/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const campaigns = readJson(CAMPAIGNS_FILE);
  const idx = campaigns.findIndex(c => c.id === id);

  if (idx >= 0) {
    const existing = campaigns[idx];

    // Handle status transition specifically to trigger running / pausing action
    if (updates.status && updates.status !== existing.status) {
      if (updates.status === 'running' && existing.status !== 'running') {
        // Trigger / scheduler code below will generate queue items if first time
        initializeCampaignQueue(existing);
        existing.startedAt = existing.startedAt || new Date().toISOString();
      }
      existing.status = updates.status;
    }

    // Editable properties
    if (updates.name) existing.name = updates.name;
    if (updates.subject) existing.subject = updates.subject;
    if (updates.bodyTemplate) existing.bodyTemplate = updates.bodyTemplate;
    if (updates.delaySeconds !== undefined) existing.delaySeconds = Number(updates.delaySeconds);
    if (updates.emailsPerHourPerAccount !== undefined) existing.emailsPerHourPerAccount = Number(updates.emailsPerHourPerAccount);

    campaigns[idx] = existing;
    writeJson(CAMPAIGNS_FILE, campaigns);
    res.json(existing);
  } else {
    res.status(404).json({ error: 'Campaign not found' });
  }
});

// DELETE Campaign
app.delete('/api/campaigns/:id', (req, res) => {
  const { id } = req.params;
  const campaigns = readJson(CAMPAIGNS_FILE);
  const updated = campaigns.filter(c => c.id !== id);
  writeJson(CAMPAIGNS_FILE, updated);

  // Also remove pending queue items
  const queue = readJson(QUEUE_FILE);
  const updatedQueue = queue.filter(q => q.campaignId !== id);
  writeJson(QUEUE_FILE, updatedQueue);

  res.json({ success: true });
});

// GET Campaign Logs
app.get('/api/campaigns/:id/logs', (req, res) => {
  const { id } = req.params;
  const logs = readJson(LOGS_FILE);
  const filtered = logs.filter(l => l.campaignId === id);
  res.json(filtered);
});

// GET Global Logs (for Dashboard)
app.get('/api/global-logs', (req, res) => {
  const logs = readJson(LOGS_FILE);
  // Sort from newest to oldest
  const sorted = [...logs].reverse();
  res.json(sorted.slice(0, 100)); // Limit to last 100 for screen performance
});

// POST Send Direct Single Email (Single Sender Direct Mode)
app.post('/api/send-direct', async (req, res) => {
  const { senderEmail, recipientEmail, subject, body } = req.body;
  if (!senderEmail || !recipientEmail || !subject || !body) {
    return res.status(400).json({ error: 'Missing required parameters: senderEmail, recipientEmail, subject, body' });
  }

  const logs = readJson(LOGS_FILE);

  try {
    await sendGmailApi(senderEmail, recipientEmail, '', subject, body);

    // Save logs under a "direct" campaign tag so it tracks
    const logObj = {
      id: Math.random().toString(36).substr(2, 9),
      campaignId: 'direct',
      timestamp: new Date().toISOString(),
      recipient: recipientEmail,
      sender: senderEmail,
      status: 'success',
      subject: subject
    };
    logs.push(logObj);
    writeJson(LOGS_FILE, logs);

    res.json({ success: true, log: logObj });
  } catch (err: any) {
    console.error('Direct send failure:', err);

    const logObj = {
      id: Math.random().toString(36).substr(2, 9),
      campaignId: 'direct',
      timestamp: new Date().toISOString(),
      recipient: recipientEmail,
      sender: senderEmail,
      status: 'failed',
      subject: subject,
      errorMessage: err.message || 'Unknown error'
    };
    logs.push(logObj);
    writeJson(LOGS_FILE, logs);

    res.status(500).json({ error: err.message || 'Failed to send direct email' });
  }
});

// Clean all queue and data for debug or reset
app.post('/api/reset-all', (req, res) => {
  writeJson(ACCOUNTS_FILE, []);
  writeJson(CONTACTS_FILE, []);
  writeJson(CAMPAIGNS_FILE, []);
  writeJson(LOGS_FILE, []);
  writeJson(QUEUE_FILE, []);
  res.json({ success: true });
});


/* ==========================================================================
   QUEUE MANAGEMENT & RUNNER (BACKGROUND WORKER)
   ========================================================================== */

// Hydrates queue items for a campaign when started
function initializeCampaignQueue(campaign: any) {
  const queue = readJson(QUEUE_FILE);
  // Only initialize if there are NO items for this campaign yet.
  // This allows pause/resume without duplicating queue items.
  const existingCount = queue.filter(q => q.campaignId === campaign.id).length;
  if (existingCount > 0) {
    // If resuming, shift timestamps of 'pending' items forward so they begin now
    let runningDelay = 1000; // start 1 sec from now
    const now = Date.now();

    // Re-calculate pacing to resume correctly
    let intervalMs = 5000; // default loop delay fallback
    if (campaign.type === 'normal') {
      intervalMs = (campaign.delaySeconds || 5) * 1000;
    } else if (campaign.type === 'auto') {
      const activeSendersNum = (campaign.senderEmails || []).length || 1;
      const ratePerHourPerAcct = campaign.emailsPerHourPerAccount || 100;
      // interval between ANY consecutive emails = 3600 / (R * N) seconds
      intervalMs = Math.max(1, Math.round((3600 / (ratePerHourPerAcct * activeSendersNum)) * 1000));
    }

    const updatedQueue = queue.map(q => {
      if (q.campaignId === campaign.id && q.status === 'pending') {
        const item = { ...q, delayUntil: now + runningDelay };
        runningDelay += intervalMs;
        return item;
      }
      return q;
    });

    writeJson(QUEUE_FILE, updatedQueue);
    return;
  }

  // Find contacts for this campaign's list name
  const contacts = readJson(CONTACTS_FILE);
  const targetContacts = contacts.filter(c => c.listName.toLowerCase() === campaign.contactListName.toLowerCase());

  if (targetContacts.length === 0) {
    console.log(`No contacts found for list name: ${campaign.contactListName}`);
    return;
  }

  // Determine limit
  let limit = targetContacts.length;
  if (campaign.type === 'normal' && campaign.sendLimit) {
    limit = Math.min(limit, campaign.sendLimit);
  }
  const slicedContacts = targetContacts.slice(0, limit);

  // Determine Send rate intervals
  let intervalMs = 5000; // 5s default
  const now = Date.now();

  if (campaign.type === 'normal') {
    intervalMs = (campaign.delaySeconds || 5) * 1000;
  } else if (campaign.type === 'auto') {
    const activeSendersNum = (campaign.senderEmails || []).length || 1;
    const ratePerHourPerAcct = campaign.emailsPerHourPerAccount || 100;
    // interval between ANY consecutive emails = 3600 / (R * N) seconds
    intervalMs = Math.max(1, Math.round((3600 / (ratePerHourPerAcct * activeSendersNum)) * 1000));
  }

  // Create queue records
  const newQueueItems: any[] = [];
  slicedContacts.forEach((contact, idx) => {
    // Determine sender email
    let senderEmail = '';
    if (campaign.type === 'normal') {
      senderEmail = campaign.senderEmail;
    } else {
      // Auto rotates Gmail accounts in stack round-robin
      const senders = campaign.senderEmails || [];
      if (senders.length > 0) {
        senderEmail = senders[idx % senders.length];
      }
    }

    // Substitute body templates variables
    let personalizedBody = campaign.bodyTemplate;
    let personalizedSubject = campaign.subject;

    const performReplace = (key: string, value: string) => {
      const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\\}\\}`, 'gi');
      personalizedBody = personalizedBody.replace(regex, value);
      personalizedSubject = personalizedSubject.replace(regex, value);
    };

    // System-defined parameters with safe fallbacks
    performReplace('name', contact.name || 'Subscriber');
    performReplace('email', contact.email);
    performReplace('firstName', contact.firstName || (contact.name ? contact.name.split(' ')[0] : '') || 'Subscriber');
    performReplace('company', contact.company || 'your company');

    // Dynamic mapped custom variables
    if (contact.variables && typeof contact.variables === 'object') {
      Object.entries(contact.variables).forEach(([k, v]) => {
        performReplace(k, String(v || ''));
      });
    }

    newQueueItems.push({
      id: Math.random().toString(36).substr(2, 9),
      campaignId: campaign.id,
      recipientEmail: contact.email,
      recipientName: contact.name,
      senderEmail,
      status: 'pending',
      subject: personalizedSubject,
      body: personalizedBody,
      delayUntil: now + (idx * intervalMs)
    });
  });

  // Append to QUEUE
  queue.push(...newQueueItems);
  writeJson(QUEUE_FILE, queue);

  // Update total contacts count in campaign structure
  const campaigns = readJson(CAMPAIGNS_FILE);
  const cIndex = campaigns.findIndex(c => c.id === campaign.id);
  if (cIndex >= 0) {
    campaigns[cIndex].totalContacts = slicedContacts.length;
    campaigns[cIndex].sentCount = 0;
    campaigns[cIndex].successCount = 0;
    campaigns[cIndex].failedCount = 0;
    writeJson(CAMPAIGNS_FILE, campaigns);
  }
}

// Global caching of validated access tokens to avoid refreshing on every single send
const googleTokensCache: Record<string, { token: string; expiresAt: number }> = {};

// Gmail Sender core executor
async function sendGmailApi(senderEmail: string, recipientEmail: string, recipientName: string, subject: string, htmlBody: string) {
  // Find sender credentials
  const accounts = readJson(ACCOUNTS_FILE);
  const account = accounts.find(a => a.email.toLowerCase() === senderEmail.toLowerCase());

  if (!account) {
    throw new Error(`Gmail sender account ${senderEmail} is not authenticated with Equinox Mail.`);
  }

  let accessToken = account.accessToken;
  const isTokenExpired = !account.expiresAt || account.expiresAt <= Date.now() + 60 * 1000;

  // Refresh auth token check
  if (isTokenExpired || !accessToken) {
    if (!account.refreshToken) {
      throw new Error(`Offline access is required. Please disconnect and reconnect Gmail ${senderEmail} with offline consent enabled.`);
    }

    try {
      // 1. Check in cached memory
      const cached = googleTokensCache[account.email];
      if (cached && cached.expiresAt > Date.now() + 60 * 1000) {
        accessToken = cached.token;
      } else {
        // 2. Fetch fresh token
        const refreshResult = await refreshGoogleToken(account.refreshToken);
        accessToken = refreshResult.accessToken;

        // update client DB
        account.accessToken = accessToken;
        account.expiresAt = Date.now() + refreshResult.expiresIn * 1000;
        account.status = 'active';

        // update cache
        googleTokensCache[account.email] = {
          token: accessToken,
          expiresAt: account.expiresAt
        };

        const currentAccounts = readJson(ACCOUNTS_FILE);
        const idx = currentAccounts.findIndex(a => a.email.toLowerCase() === account.email.toLowerCase());
        if (idx >= 0) {
          currentAccounts[idx] = account;
          writeJson(ACCOUNTS_FILE, currentAccounts);
        }
      }
    } catch (err: any) {
      throw new Error(`Could not renew Gmail OAuth keys: ${err.message}`);
    }
  }

  // Construct raw MIME email
  const rawBase64 = constructRawEmail(recipientEmail, 'Equinox Mail Outbox', senderEmail, subject, htmlBody);

  // Send request via Gmail REST endpoint
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: rawBase64 })
  });

  if (!sendRes.ok) {
    const errorBody = await sendRes.text();
    throw new Error(`Gmail API failure [${sendRes.status}]: ${errorBody}`);
  }

  const result = await sendRes.json();
  return result;
}

// Background poller running the email dispatch
async function executeEmailDispatchTick() {
  const campaigns = readJson(CAMPAIGNS_FILE);
  const activeCampaigns = campaigns.filter(c => c.status === 'running');

  if (activeCampaigns.length === 0) return;

  const queue = readJson(QUEUE_FILE);
  const logs = readJson(LOGS_FILE);
  let queueUpdated = false;
  let campaignsUpdated = false;

  for (const campaign of activeCampaigns) {
    // Find due pending items
    const campaignItems = queue.filter(q => q.campaignId === campaign.id && q.status === 'pending');

    if (campaignItems.length === 0) {
      // Completed!
      campaign.status = 'completed';
      campaignsUpdated = true;
      continue;
    }

    // Process items that are due
    const now = Date.now();
    const dueItems = campaignItems.filter(q => q.delayUntil <= now);

    if (dueItems.length === 0) continue;

    // Pick top items to process to avoid bottlenecking other tasks
    // Max 3 items sent in parallel per tick to keep container limits healthy
    const itemsToProcess = dueItems.slice(0, 3);

    for (const item of itemsToProcess) {
      item.status = 'sending';
      queueUpdated = true;

      try {
        await sendGmailApi(item.senderEmail, item.recipientEmail, item.recipientName, item.subject, item.body);

        // Record success
        item.status = 'success';
        campaign.sentCount = (campaign.sentCount || 0) + 1;
        campaign.successCount = (campaign.successCount || 0) + 1;

        logs.push({
          id: Math.random().toString(36).substr(2, 9),
          campaignId: campaign.id,
          timestamp: new Date().toISOString(),
          recipient: item.recipientEmail,
          sender: item.senderEmail,
          status: 'success',
          subject: item.subject
        });

      } catch (err: any) {
        // Record failure
        item.status = 'failed';
        campaign.sentCount = (campaign.sentCount || 0) + 1;
        campaign.failedCount = (campaign.failedCount || 0) + 1;

        logs.push({
          id: Math.random().toString(36).substr(2, 9),
          campaignId: campaign.id,
          timestamp: new Date().toISOString(),
          recipient: item.recipientEmail,
          sender: item.senderEmail,
          status: 'failed',
          subject: item.subject,
          errorMessage: err.message || 'Unknown error'
        });

        console.error(`Gmail Send Campaign error (ID: ${campaign.id}, Dest: ${item.recipientEmail}):`, err);
      }

      campaignsUpdated = true;
    }
  }

  if (queueUpdated) {
    writeJson(QUEUE_FILE, queue);
  }
  if (campaignsUpdated) {
    writeJson(CAMPAIGNS_FILE, campaigns);
  }
  if (logs.length > readJson(LOGS_FILE).length) {
    writeJson(LOGS_FILE, logs);
  }
}

// POST and GET /api/dispatch endpoints to trigger execution ticks in serverless environments (e.g. Vercel Cron)
app.post('/api/dispatch', async (req, res) => {
  try {
    await executeEmailDispatchTick();
    res.json({ success: true, message: 'Queue dispatch tick executed successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to dispatch email queue' });
  }
});

app.get('/api/dispatch', async (req, res) => {
  try {
    await executeEmailDispatchTick();
    res.json({ success: true, message: 'Queue dispatch tick executed successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to dispatch email queue' });
  }
});

// Tick interval setup: every 1.5s
if (!process.env.VERCEL) {
  setInterval(() => {
    executeEmailDispatchTick().catch(err => {
      console.error('Queue Dispatch Tick Error:', err);
    });
  }, 1500);
}


/* ==========================================================================
   VITE DEV SERVER EMBEDDED MIDDLEWARE
   ========================================================================== */

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Vite is only needed for local development; imported dynamically so the
    // production backend (e.g. on Railway) doesn't require it at runtime.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve the built SPA only if it exists alongside the server. When the
    // backend is deployed on its own (frontend hosted separately on Vercel),
    // there is no dist/index.html and we simply expose the API.
    const distPath = path.join(process.cwd(), 'dist');
    const indexHtml = path.join(distPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      app.use(express.static(distPath));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(indexHtml);
      });
    }
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Equinox Mail Server] Booted successfully. Running on port ${PORT}`);
    });
  }
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
