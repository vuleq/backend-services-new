import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse/sync';
import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { Readable } from 'stream';

const defaultUserId = '00000000-0000-0000-0000-000000000000';

const s3Client = new S3Client();

interface CsvRecord {
  email: string;
  new_id: string;
}

interface UserFromDb {
  id: string;
  email: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    console.log("===== START Lambda (CSV ID Mapping - Change User ID) =====");
    console.log("Received event:", JSON.stringify(event, null, 2));

    const params = event.queryStringParameters ?? {};
    const bucket = params.bucket;
    const key = params.key;

    if (!bucket || !key) {
      return new LambdaResponse(400, new ApiResponse(false, null, "bucket and key are required in query params"));
    }

    console.log(`Reading CSV mapping from S3: ${bucket}/${key}`);
    const mapping = await getEmailIdMappingFromCsv(bucket, key);
    console.log("CSV Mapping loaded:", mapping);

    console.log("Fetching users from DB...");
    const dbUsers = await getAllUsers();
    console.log(`Found ${dbUsers.length} users in DB`);

    console.log("Fetching tables with created_by / updated_by columns...");
    const tablesWithUserFields = await getTablesWithUserFields();
    console.log("Found tables:", tablesWithUserFields);

    console.log("Fetching foreign key references to users.id...");
    const fkColumns = await getForeignKeyColumnsReferencingUsers();
    console.log("Found FK columns:", fkColumns);

    const results: any[] = [];

    for (const user of dbUsers) {
      const newId = mapping[user.email.toLowerCase()];
      if (!newId) {
        console.log(`No mapping found for ${user.email} (${user.id})`);
        results.push({ oldId: user.id, email: user.email, status: "skipped" });
        continue;
      }

      console.log(`Updating user ${user.email}: ${user.id} -> ${newId}`);
      try {
        await createUserWithNewId(newId, user.email);
        await updateRelatedTables(user.id, newId, tablesWithUserFields, fkColumns);
        await deleteOldUser(user.id);
        results.push({ oldId: user.id, newId, email: user.email, status: "success" });
      } catch (err) {
        console.error(`Failed to update user ${user.email}`, err);
        results.push({ oldId: user.id, newId, email: user.email, status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    const failedCount = results.filter(r => r.status === "failed").length;
    const skippedCount = results.filter(r => r.status === "skipped").length;

    console.log("\n===== SUMMARY =====");
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Skipped (no mapping): ${skippedCount}`);

    return new LambdaResponse(200, new ApiResponse(true, { results }, `Processed ${successCount} users successfully`));
  } catch (error) {
    console.error("Fatal error:", error);
    return new LambdaResponse(500, new ApiResponse(false, null, "Error processing users"));
  }
};

async function getEmailIdMappingFromCsv(bucket: string, key: string): Promise<Record<string, string>> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  if (!response.Body) throw new Error("Empty CSV file");

  const csvBuffer = response.Body instanceof Buffer
    ? response.Body
    : await streamToBuffer(response.Body as any);

  const records = parse(csvBuffer.toString('utf-8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  const mapping: Record<string, string> = {};

  for (const row of records) {
    const email = (row["Email address"] || "").toLowerCase().trim();
    const newId = (row["User name"] || "").trim();

    // Bỏ qua mọi dòng header lặp lại
    if (!email || !newId || email === "email address") continue;

    mapping[email] = newId;
  }

  return mapping;
}

// Helper: convert ReadableStream -> Buffer
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
async function getAllUsers(): Promise<UserFromDb[]> {
  const query = `SELECT id, email FROM users`;
  const result = await executeQuery(query);
  return result.data;
}

async function getTablesWithUserFields(): Promise<string[]> {
  const query = `
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name IN ('created_by', 'updated_by')
    GROUP BY table_name
    HAVING count(*) > 0
  `;
  const result = await executeQuery(query);
  return result.data.map((row: any) => row.table_name);
}

async function getForeignKeyColumnsReferencingUsers(): Promise<{ table_name: string, column_name: string }[]> {
  const query = `
    SELECT DISTINCT kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users'
      AND ccu.column_name = 'id'
  `;
  const result = await executeQuery(query);
  return result.data;
}

async function updateRelatedTables(oldUserId: string, newUserId: string, tables: string[], fkColumns: { table_name: string, column_name: string }[]) {
  const operations: Operation[] = [];

  // Update created_by / updated_by
  operations.push(
    ...tables.flatMap(table => [
      {
        type: 'query' as const,
        queryText: `UPDATE ${table} SET created_by = $1 WHERE created_by = $2`,
        params: [newUserId, oldUserId]
      },
      {
        type: 'query' as const,
        queryText: `UPDATE ${table} SET updated_by = $1 WHERE updated_by = $2`,
        params: [newUserId, oldUserId]
      }
    ])
  );

  // Update files.uploaded_by
  operations.push({
    type: 'query',
    queryText: `UPDATE files SET uploaded_by = $1 WHERE uploaded_by = $2`,
    params: [newUserId, oldUserId]
  });

  // Update foreign key references
  operations.push(
    ...fkColumns.map(({ table_name, column_name }) => ({
      type: 'query' as const,
      queryText: `UPDATE ${table_name} SET ${column_name} = $1 WHERE ${column_name} = $2`,
      params: [newUserId, oldUserId]
    }))
  );

  await performTransaction(operations);
}

async function createUserWithNewId(newUserId: string, email: string) {
  const querySelect = `SELECT * FROM users WHERE email = $1`;
  const resultSelect = await executeQuery(querySelect, [email]);

  if (resultSelect.rowCount === 0) {
    throw new Error(`User with email ${email} not found`);
  }

  const oldUser = resultSelect.data[0];

  const queryInsert = `
    INSERT INTO users (id, email, name, created_at, updated_at, created_by, updated_by)
    VALUES ($1, $2, $3, NOW(), NOW(), $4, $5)
  `;
  await executeQuery(queryInsert, [
    newUserId,
    oldUser.email,
    oldUser.name,
    defaultUserId,
    defaultUserId
  ]);
}

async function deleteOldUser(userId: string) {
  const query = 'DELETE FROM users WHERE id = $1';
  await executeQuery(query, [userId]);
}