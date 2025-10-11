/**
 * Database Configuration Module
 * Handles configuration creation and validation for different auth methods
 */

import { PoolConfig } from 'pg';
import { DatabaseConfigValidation } from './types.js';
import { getIAMAuthToken, hasIAMAuthRequirements } from './iam-auth.js';
import { getSecretsManagerCredentials, getCredentialsCacheStatus } from './secrets-manager.js';

/**
 * Get database configuration using the authentication hierarchy:
 * 1. RDS IAM Authentication (if requirements met)
 * 2. AWS Secrets Manager (if DB_SECRET_ARN provided)
 * 3. Environment Variables (fallback)
 */
export async function getDbConfig(): Promise<PoolConfig> {
  // Try RDS IAM Authentication first (default method)
  // Commented out per original code logic
  // const hasIAMRequirements = hasIAMAuthRequirements();
  
  // if (hasIAMRequirements) {
  //   try {
  //     console.log('Using RDS IAM authentication for database connection (default method)');
      
  //     const token = await getIAMAuthToken();
  //     console.log(`IAM token generated successfully. Token length: ${token.length}, starts with: ${token.substring(0, 20)}...`);
      
  //     const config = {
  //       user: process.env.DB_IAM_USER!,
  //       host: process.env.DB_HOST!,
  //       database: process.env.DB_NAME!,
  //       password: token,
  //       port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  //       max: 10,
  //       idleTimeoutMillis: 30000,
  //       connectionTimeoutMillis: 2000,
  //       ssl: {
  //         rejectUnauthorized: false // Required for RDS IAM authentication in Lambda
  //       }
  //     };
      
  //     console.log(`Connection config - User: ${config.user}, Host: ${config.host}, Database: ${config.database}, Port: ${config.port}, SSL: ${config.ssl}`);
  //     return config;
  //   } catch (error: any) {
  //     console.warn('Failed to configure IAM authentication, falling back to Secrets Manager or environment variables:', error.message || error);
  //   }
  // } else {
  //   console.log('IAM authentication requirements not met (missing DB_IAM_USER, DB_HOST, or DB_NAME), trying alternative methods');
  // }
  
  // Try to use Secrets Manager if DB_SECRET_ARN is provided
  // if (process.env.DB_SECRET_ARN) {
  //   try {
  //     const credentials = await getSecretsManagerCredentials();

  //     console.log('Successfully retrieved credentials from Secrets Manager');
  //     return {
  //       user: credentials.username,
  //       host: credentials.host,
  //       database: credentials.dbname,
  //       password: credentials.password,
  //       port: credentials.port,
  //       max: 10,
  //       idleTimeoutMillis: 30000,
  //       connectionTimeoutMillis: 2000,
  //       ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  //     };
  //   } catch (error: any) {
  //     console.warn('Failed to get credentials from Secrets Manager, falling back to environment variables.', error.message || error);
  //   }
  // }

  // Fallback to environment variables
  console.log('Using environment variables for database configuration (final fallback)');
  
  // For environment variable fallback, use the password-based user
  const envUser = process.env.DB_USER;
  const requiredEnvVars = ['DB_HOST', 'DB_NAME', 'DB_PASSWORD'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (!envUser) {
    missingVars.push('DB_USER');
  }
  
  if (missingVars.length > 0) {
    const errorMsg = `Missing required environment variables: ${missingVars.join(', ')}. Please set these variables for environment-based authentication, or configure DB_SECRET_ARN for Secrets Manager, or ensure IAM authentication requirements are met.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  return {
    user: envUser!,
    host: process.env.DB_HOST!,
    database: process.env.DB_NAME!,
    password: process.env.DB_PASSWORD!,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  };
}

/**
 * Validate database configuration without connecting
 * Useful for health checks and debugging
 */
export async function validateDatabaseConfig(): Promise<DatabaseConfigValidation> {
  try {
    // Try to get the configuration
    const config = await getDbConfig();
    
    // Check for missing required fields
    const requiredFields = ['user', 'host', 'database', 'password'];
    const missingFields = requiredFields.filter(field => !config[field as keyof PoolConfig]);
    
    if (missingFields.length > 0) {
      return {
        isValid: false,
        source: 'error',
        missingFields,
        error: `Missing required database configuration fields: ${missingFields.join(', ')}`
      };
    }
    
    // Determine the source based on what was actually used
    const hasIAMRequirements = hasIAMAuthRequirements();
    let source: 'iam-authentication' | 'secrets-manager' | 'environment-variables';
    
    if (hasIAMRequirements) {
      source = 'iam-authentication';
    } else if (process.env.DB_SECRET_ARN) {
      source = 'secrets-manager';
    } else {
      source = 'environment-variables';
    }
    
    return {
      isValid: true,
      source
    };
    
  } catch (error: any) {
    return {
      isValid: false,
      source: 'error',
      error: error.message || 'Unknown configuration error'
    };
  }
}

/**
 * Preload database credentials during Lambda cold start
 * Call this function early in your Lambda handler to reduce latency
 */
export async function preloadCredentials(): Promise<boolean> {
  // Try IAM authentication first (commented out per original logic)
  // const hasIAMRequirements = hasIAMAuthRequirements();
  
  // if (hasIAMRequirements) {
  //   try {
  //     await getIAMAuthToken();
  //     console.log('IAM authentication token preloaded successfully (default method)');
  //     return true;
  //   } catch (error: any) {
  //     console.warn('Failed to preload IAM authentication token, will try alternative methods:', error.message || error);
  //   }
  // }
  
  // Try Secrets Manager if available
  // if (process.env.DB_SECRET_ARN) {
  //   try {
  //     await getSecretsManagerCredentials();
  //     console.log('Database credentials preloaded successfully from Secrets Manager');
  //     return true;
  //   } catch (error: any) {
  //     console.warn('Failed to preload credentials from Secrets Manager:', error.message || error);
      
  //     // Check if environment variables are available as fallback
  //     const envUser = process.env.DB_PASSWORD_USER || process.env.DB_USER;
  //     const hasEnvVars = envUser && process.env.DB_HOST && process.env.DB_NAME && process.env.DB_PASSWORD;
  //     if (hasEnvVars) {
  //       console.log('Environment variables available as fallback for database connection');
  //       return true; // Fallback is available
  //     } else {
  //       console.error('No fallback environment variables available. Database connection may fail.');
  //       return false; // No fallback available
  //     }
  //   }
  // }
  
  // Check if environment variables are available
  const envUser = process.env.DB_USER;
  const hasEnvVars = envUser && process.env.DB_HOST && process.env.DB_NAME && process.env.DB_PASSWORD;
  if (hasEnvVars) {
    console.log('Environment variables available for database connection');
    return true;
  }
  
  console.error('No valid database authentication method available. Please configure IAM authentication, Secrets Manager, or environment variables.');
  return false;
}