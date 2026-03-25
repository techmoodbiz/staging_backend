import { google } from 'googleapis';
import fs from 'fs';
import readline from 'readline';

// Instructions:
// 1. Ensure you have 'oauth_credentials.json' (Desktop App) in this folder.
// 2. Run: `node generate_gsc_refresh_token.js`
// 3. Follow the link, authorize, and paste the code back.

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly'
];

async function main() {
  if (!fs.existsSync('oauth_credentials.json')) {
    console.log('Error: oauth_credentials.json not found.');
    return;
  }

  const credentials = JSON.parse(fs.readFileSync('oauth_credentials.json')).installed || JSON.parse(fs.readFileSync('oauth_credentials.json')).web;
  const { client_secret, client_id, redirect_uris } = credentials;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // Critical for getting a refresh token
    scope: SCOPES,
    prompt: 'consent' // Forces consent screen to ensure refresh token is returned
  });

  console.log('\n--- GSC REFRESH TOKEN GENERATOR ---');
  console.log('1. Visit this URL in your browser:');
  console.log(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('\n2. Enter the code from the redirect URL here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code);
      console.log('\n--- SUCCESS! ---');
      console.log('Save these values to your Vercel Environment Variables:');
      console.log('----------------------------------------------------');
      console.log(`GSC_REFRESH_TOKEN="${tokens.refresh_token}"`);
      console.log(`GSC_CLIENT_ID="${client_id}"`);
      console.log(`GSC_CLIENT_SECRET="${client_secret}"`);
      console.log('----------------------------------------------------');
      console.log('\nNote: Keep the GSC_REFRESH_TOKEN secret. Do not share it.');
    } catch (err) {
      console.error('Error retrieving tokens:', err.message);
    }
  });
}

main();
