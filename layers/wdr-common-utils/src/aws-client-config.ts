/**
 * AWS SDK v3 Client Configuration Utility
 * 
 * This utility provides standardized configurations for AWS SDK clients
 * to prevent intermittent connection timeout errors and optimize performance.
 * 
 * Features:
 * - Connection pooling and keep-alive
 * - Adaptive retry strategy
 * - Proper timeout configurations
 * - Connection reuse optimization
 */

import { Agent as HttpsAgent } from 'https';

export interface AWSClientConfig {
  region?: string;
  requestHandler?: any;
  maxAttempts?: number;
  retryMode?: 'standard' | 'adaptive';
}

/**
 * Creates a standardized configuration for AWS SDK clients
 * 
 * @param options - Configuration options
 * @param options.timeout - Request timeout in milliseconds (default: 30000)
 * @param options.maxAttempts - Maximum retry attempts (default: 3)
 * @param options.region - AWS region (default: process.env.AWS_REGION || 'ap-southeast-1')
 * @param options.connectionTimeout - Connection timeout in milliseconds (default: 5000)
 * @returns AWS client configuration object
 */
export function createAWSClientConfig(options: {
  timeout?: number;
  maxAttempts?: number;
  region?: string;
  connectionTimeout?: number;
} = {}): AWSClientConfig {
  const {
    timeout = 30000,
    maxAttempts = 3,
    region = process.env.AWS_REGION || 'ap-southeast-1',
    connectionTimeout = 5000
  } = options;

  return {
    region,
    requestHandler: {
      requestTimeout: timeout,
      connectionTimeout,
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: connectionTimeout,
      }),
    },
    maxAttempts,
    retryMode: 'adaptive' as const,
  };
}

/**
 * Creates a configuration optimized for short-lived operations
 * Good for: Secrets Manager, Parameter Store, short Lambda invocations
 */
export function createFastClientConfig(region?: string): AWSClientConfig {
  return createAWSClientConfig({
    timeout: 10000,
    maxAttempts: 2,
    region,
    connectionTimeout: 3000
  });
}

/**
 * Creates a configuration optimized for long-running operations
 * Good for: S3 uploads/downloads, SQS polling, long Lambda invocations
 */
export function createLongRunningClientConfig(region?: string): AWSClientConfig {
  return createAWSClientConfig({
    timeout: 60000,
    maxAttempts: 3,
    region,
    connectionTimeout: 5000
  });
}

/**
 * Creates a configuration optimized for batch operations
 * Good for: DynamoDB batch operations, S3 multipart uploads
 */
export function createBatchClientConfig(region?: string): AWSClientConfig {
  return createAWSClientConfig({
    timeout: 45000,
    maxAttempts: 4,
    region,
    connectionTimeout: 5000
  });
}

/**
 * Creates a configuration for critical operations that need high reliability
 * Good for: Database connections, critical business operations
 */
export function createReliableClientConfig(region?: string): AWSClientConfig {
  return createAWSClientConfig({
    timeout: 30000,
    maxAttempts: 5,
    region,
    connectionTimeout: 5000
  });
}
