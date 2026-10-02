import dotenv from "dotenv";
import OAuth from "oauth";
import readline from "readline";

dotenv.config({ path: "./.env" });

const oauth = new OAuth.OAuth(
  "https://api.discogs.com/oauth/request_token",
  "https://api.discogs.com/oauth/access_token",
  process.env.DISCOGS_CONSUMER_KEY,
  process.env.DISCOGS_CONSUMER_SECRET,
  "1.0A",
  null,
  "HMAC-SHA1"
);

function ask(q) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((res) =>
    rl.question(q, (ans) => {
      rl.close();
      res(ans);
    })
  );
}

console.log("Requesting token...");

oauth.getOAuthRequestToken(async (err, oauthToken, oauthTokenSecret) => {
  if (err) {
    console.log("REQUEST TOKEN ERROR:", err);
    return;
  }

  console.log("\n1. Open this URL:");
  console.log(
    `https://www.discogs.com/oauth/authorize?oauth_token=${oauthToken}`
  );

  const verifier = await ask("\n2. Paste verifier: ");

  oauth.getOAuthAccessToken(
    oauthToken,
    oauthTokenSecret,
    verifier,
    (err, accessToken, accessSecret) => {
      if (err) {
        console.log("ACCESS TOKEN ERROR:", err);
        return;
      }

      console.log("\n✅ SUCCESS:");
      console.log("DISCOGS_ACCESS_TOKEN=" + accessToken);
      console.log("DISCOGS_ACCESS_SECRET=" + accessSecret);
    }
  );
});