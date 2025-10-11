import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { decodeToken } from 'wdr-common-utils';

type Role = {
  id: string;
  name: string;
  description?: string | null;
  code?: string | null;
};

const defaultUserId = '00000000-0000-0000-0000-000000000000';

export const handler: Handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log("=== Create Role API Called ===");

    if (!event.body) {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Request body is required"),
        400
      );
    }

    let body: any;
    if (typeof event.body === "string") {
      try {
        body = JSON.parse(event.body);
      } catch (err) {
        return LambdaResponse.error(
          new ApiResponse(false, null, "Invalid JSON body"),
          400
        );
      }
    } else {
      body = event.body;
    }

    const { name, description } = body;

    if (!name || typeof name !== "string" || name.trim() === "") {
      return LambdaResponse.error(
        new ApiResponse(false, null, "Role name is required"),
        400
      );
    }


    let currentUserId = event.requestContext?.authorizer?.claims?.sub || defaultUserId;

    if (currentUserId === defaultUserId) {
      const rawToken = event.headers?.Authorization || event.headers?.authorization || "";
      const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7) : rawToken;

      if (token) {
        try {
          const decoded: any = decodeToken(token);
          currentUserId = decoded?.payload?.sub || currentUserId;
        } catch (err) {
          console.warn("Failed to decode token:", err);
        }
      }
    }

    console.log(`Current User: (${currentUserId})`);

    const checkSql = "SELECT id FROM roles WHERE LOWER(name) = LOWER($1)";
    const checkResult = await executeQuery(checkSql, [name.trim()]);

    if (checkResult?.data.length > 0) {
      return LambdaResponse.error(
        new ApiResponse(false, null, `Role name '${name}' already exists`),
        409
      );
    }

    const code = await generateUniqueRoleCode(name);

    const insertSql = `
      INSERT INTO roles (name, description, code, is_default, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, name, description, code
    `;
    const insertParams = [name.trim(), description, code, false, currentUserId, currentUserId];
    const insertResult = await executeQuery(insertSql, insertParams);

    if (!insertResult || insertResult.success === false || insertResult.error) {
      console.error("Database Error:", insertResult?.error || "Unknown error");
      return LambdaResponse.error(
        new ApiResponse(false, null, insertResult?.error || "Failed to create role"),
        500
      );
    }

    const createdRole: Role = insertResult.data[0];

    return LambdaResponse.success(
      new ApiResponse(true, createdRole, "Role created successfully")
    );

  } catch (error: any) {
    console.error("Unhandled Error:", error);
    return LambdaResponse.error(
      new ApiResponse(false, null, error?.message || "An unexpected error occurred while creating role"),
      500
    );
  }
};

async function generateUniqueRoleCode(name: string): Promise<string> {
  const baseCode = generateRoleCode(name);
  let finalCode = baseCode;
  let counter = 1;

  while (true) {
    const result = await executeQuery(
      "SELECT id FROM roles WHERE code = $1",
      [finalCode]
    );

    if (!result?.data || result.data.length === 0) {
      return finalCode;
    }

    finalCode = `${baseCode}${counter}`;
    counter++;
  }
}

function generateRoleCode(name: string): string {
  const words = name.trim().split(/\s+/);

  if (words.length === 1) {
    return words[0].substring(0, 3).toUpperCase();
  }

  return words.map(w => w[0].toUpperCase()).join("");
}
