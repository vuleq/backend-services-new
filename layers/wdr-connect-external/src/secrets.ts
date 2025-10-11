// Cache for the Lambda execution context - secrets don't change during execution
const secretCache = new Map<string, string>();

export async function getSecret(secretName: string): Promise<string> {
  // Check cache first
  const cached = secretCache.get(secretName);
  if (cached) {
    console.log(`Cache hit for secret: ${secretName}`);
    return cached;
  }

  console.log(`Cache miss for secret: ${secretName}`);
  
  try {
    const timeout = Number(process.env.SECRETS_MANAGER_TIMEOUT_MILLIS || 30000);
    const port = process.env.PARAMETERS_SECRETS_EXTENSION_HTTP_PORT || '2773';
    const baseUrl = `http://localhost:${port}`;

    const response = await fetch(`${baseUrl}/secretsmanager/get?secretId=${secretName}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Aws-Parameters-Secrets-Token': process.env.AWS_SESSION_TOKEN || ''
      },
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      throw new Error(`Extension returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.SecretString) {
      throw new Error(`Secret ${secretName} has no SecretString value`);
    }

    // Cache the result
    secretCache.set(secretName, data.SecretString);
    
    return data.SecretString;
  } catch (error: any) {
    console.error('Failed to retrieve secret:', error);
    throw new Error(`Get secret failed: ${error.message}`);
  }
}

export async function getSAPCredentials(): Promise<{ SAP_USER_NAME: string; SAP_PASSWORD: string }> {
  const secretName = process.env.SAP_SECRET_NAME;
  
  if (!secretName) {
    throw new Error('SAP secret name is not defined in environment variables');
  }

  const secretString = await getSecret(secretName);
  return JSON.parse(secretString);
}