import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_ADMIN_DB } = process.env;

// Connect to default DB to create the new database
const adminDbUrl = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_ADMIN_DB || 'postgres'}`;
const newDbUrl = `postgres://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;

async function init() {
  const client = new Client({ connectionString: adminDbUrl });
  
  try {
    await client.connect();
    console.log(`Connected to admin PostgreSQL DB (${DB_ADMIN_DB || 'postgres'})`);

    const res = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]);
    if (res.rowCount === 0) {
      console.log(`Creating database ${DB_NAME}...`);
      await client.query(`CREATE DATABASE ${DB_NAME}`);
      console.log(`Database ${DB_NAME} created.`);
    } else {
      console.log(`Database ${DB_NAME} already exists.`);
    }
  } catch (err) {
    console.error("Error creating database (you might need to run this script with a superuser):", err);
  } finally {
    await client.end();
  }

  // Connect to the target database to create tables
  const appClient = new Client({ connectionString: newDbUrl });
  try {
    await appClient.connect();
    console.log(`Connected to target DB: ${DB_NAME}`);

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS jira_app_configs (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    await appClient.query(createTableQuery);
    console.log("Table jira_app_configs created/verified.");
  } catch (err) {
    console.error("Error creating tables:", err);
  } finally {
    await appClient.end();
  }
}

init();
