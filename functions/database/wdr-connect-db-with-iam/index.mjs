import { Signer } from "@aws-sdk/rds-signer";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import pkg from "pg";
const { Client } = pkg;


export const handler = async () => {

  const region = "ap-southeast-1";
  const port = 5432;
  const database = "wdr";

  const hostname = process.env.DB_HOST;
  const username = "iam_wdr_user";

  // Generate an IAM Auth token (valid 15 min)
  const signer = new Signer({
    region,
    hostname,
    port,
    username,
    credentials: defaultProvider()
  });
  
  let token;
  try {
    token = await signer.getAuthToken();
    console.log("IAM token generated successfully");
  } catch (err) {
    console.error("Failed to generate IAM token:", err);
    throw err;
  }
  
  const client = new Client({
    host: hostname,
    port,
    user: username,
    password: token,
    database: database,
    ssl: { 
      rejectUnauthorized: false,
      require: true // Ensure SSL is required for IAM auth
    }
  });

  try {
    await client.connect();
    const res = await client.query("SELECT NOW()");
    console.log("DB Time:", res.rows[0]);
    return res.rows[0];
  } catch (err) {
    console.error("DB connection failed:", err);
    throw err;
  } finally {
    await client.end();
  }
};
