/**
 * AWS RDS IAM Authentication Module
 * No caching - generates fresh IAM token every time
 */

import { Signer } from "@aws-sdk/rds-signer";

/**
 * Generate IAM authentication token for RDS
 * Always creates fresh token - no caching
 */
export async function getIAMAuthToken(): Promise<string> {
  try {
    console.log('Generating fresh IAM authentication token for RDS (no cache)...');
    
    const hostname = process.env.DB_HOST;
    const port = parseInt(process.env.DB_PORT || '5432', 10);
    const username = process.env.DB_IAM_USER;
    
    console.log(`IAM Auth Details - Host: ${hostname}, Port: ${port}, Username: ${username}, Region: ${process.env.AWS_REGION || "ap-southeast-1"}`);

    if (!hostname || !username) {
      throw new Error('DB_HOST and DB_IAM_USER environment variables are required for IAM authentication');
    }

    const rdsSigner = new Signer({
      hostname,
      port,
      username,
      region: process.env.AWS_REGION || "ap-southeast-1",
    });

    const token = await rdsSigner.getAuthToken();

    console.log('Fresh IAM authentication token generated successfully');
    return token;
  } catch (error: any) {
    console.error('Error generating IAM authentication token:', error);
    throw error;
  }
}

/**
 * Clear token cache (no-op since we don't cache)
 */
export function clearIAMTokenCache(): void {
  console.log('No IAM token cache to clear - using fresh tokens every time');
}

/**
 * Check if IAM authentication requirements are met
 */
export function hasIAMAuthRequirements(): boolean {
  return !!(process.env.DB_IAM_USER && process.env.DB_HOST && process.env.DB_NAME);
}

// Legacy function names for compatibility
export const refreshIAMToken = async (): Promise<boolean> => {
  try {
    await getIAMAuthToken();
    return true;
  } catch {
    return false;
  }
};
export const getIAMTokenCacheStatus = () => ({ isCached: false });