# WDR Database Connection Layer

Optimized PostgreSQL connection layer for AWS Lambda functions with AWS RDS IAM Authentication and intelligent credential management.

## Features

- 🔐 **RDS IAM Authentication** - Default secure authentication using AWS IAM (no passwords needed)
- ✅ **Intelligent Credential Caching** - TTL-based caching reduces API calls and improves performance
- ✅ **Smart Fallback System** - Automatic fallback: IAM → Secrets Manager → Environment Variables
- ✅ **Timeout Protection** - Configurable timeouts prevent Lambda function timeouts  
- ✅ **Cold Start Optimization** - Preload credentials during Lambda initialization
- ✅ **Transaction Support** - Multi-operation transactions with dynamic value resolution
- ✅ **Error Logging** - Comprehensive error tracking and monitoring
- ✅ **Connection Pooling** - Efficient database connection management

## Authentication Methods

The layer automatically tries authentication methods in this order:

1. **🔐 RDS IAM Authentication (Default)** - Uses AWS IAM roles to generate temporary tokens
2. **📋 AWS Secrets Manager** - Uses stored credentials from AWS Secrets Manager  
3. **⚙️ Environment Variables** - Traditional username/password authentication

## Quick Start

### IAM Authentication (Recommended)

```typescript
import { executeQuery, preloadCredentials } from 'wdr-connect-db';

export const handler = async (event, context) => {
  // Optional: Preload IAM token during cold start
  await preloadCredentials();
  
  // Execute queries - IAM authentication handled automatically
  const result = await executeQuery('SELECT * FROM users WHERE id = $1', [userId]);
  
  return {
    statusCode: 200,
    body: JSON.stringify(result.data)
  };
};
```

**Required Setup:**
1. **Environment Variables:**
   ```bash
   DB_USER=your_iam_user     # Database user with rds_iam role
   DB_HOST=your-rds-host     # RDS cluster/instance endpoint
   DB_NAME=your_database     # Database name
   DB_PORT=5432              # Optional, defaults to 5432
   ```

2. **IAM Permission** (already in template.yaml):
   ```json
   {
     "Effect": "Allow",
     "Action": "rds-db:connect",
     "Resource": "*"
   }
   ```

3. **Database User Setup:**
   ```sql
   CREATE USER your_iam_user;
   GRANT rds_iam TO your_iam_user;
   GRANT [your_permissions] TO your_iam_user;
   ```

### Environment Variables

#### Authentication Methods (Automatic Priority):

**🔐 IAM Authentication (Default - Recommended):**
```bash
DB_USER=your_iam_user     # Database user with rds_iam role
DB_HOST=your-rds-host     # RDS cluster/instance endpoint  
DB_NAME=your_database     # Database name
DB_PORT=5432              # Optional, defaults to 5432
```

**📋 Secrets Manager (Fallback):**
```bash
DB_SECRET_ARN=arn:aws:secretsmanager:region:account:secret:your-secret
```

**⚙️ Environment Variables (Final Fallback):**
```bash
DB_USER=username
DB_HOST=hostname
DB_NAME=database
DB_PASSWORD=password
DB_PORT=5432
DB_SSL=true
```

#### Optional (Performance Tuning):
```bash
# IAM token cache TTL (default: 870000 = 14.5 minutes)
DB_IAM_TOKEN_TTL=870000

# Credentials cache TTL (default: 300000 = 5 minutes)
DB_CREDENTIALS_TTL=300000

# Secrets Manager timeout (default: 3000 = 3 seconds)
DB_SECRETS_TIMEOUT=3000

# Maximum retry attempts (default: 2)
DB_SECRETS_MAX_RETRIES=2

# Database statement timeout (default: 2000 = 2 seconds)
DB_STATEMENT_TIMEOUT=2000
```

## API Reference

### Core Functions

#### `executeQuery(queryText, params)`
Execute a parameterized SQL query.

```typescript
const result = await executeQuery(
  'SELECT * FROM users WHERE created_at > $1',
  [new Date('2024-01-01')]
);

if (result.success) {
  console.log('Data:', result.data);
  console.log('Row count:', result.rowCount);
} else {
  console.error('Error:', result.error);
}
```

#### `insertRecord(tableName, data, returningClause)`
Insert a record and optionally return values.

```typescript
const result = await insertRecord('users', {
  name: 'John Doe',
  email: 'john@example.com'
}, 'id, created_at');

if (result.success) {
  console.log('New user ID:', result.data.id);
}
```

#### `updateRecord(tableName, data, condition, returningClause)`
Update records matching a condition.

```typescript
const result = await updateRecord(
  'users',
  { name: 'Jane Doe' },
  { id: userId },
  'name, updated_at'
);
```

#### `deleteRecord(tableName, condition, returningClause)`
Delete records matching a condition.

```typescript
const result = await deleteRecord('users', { id: userId });
console.log('Deleted rows:', result.rowCount);
```

#### `performTransaction(operations)`
Execute multiple operations in a transaction with dynamic value resolution.

```typescript
const result = await performTransaction([
  {
    type: 'insert',
    table: 'orders',
    data: { user_id: userId, total: 100.00 },
    returningClause: 'id'
  },
  {
    type: 'insert',
    table: 'order_items',
    data: {
      order_id: { type: 'dynamic_result', fromIndex: 0, field: 'id' },
      product_id: productId,
      quantity: 2
    }
  }
]);
```

### Optimization Functions

#### `preloadCredentials()`
Preload database credentials/tokens during Lambda cold start.

```typescript
// Call early in your handler for optimal performance
const success = await preloadCredentials();
console.log('Preload successful:', success);

// Works with all authentication methods:
// - Preloads IAM token for IAM authentication
// - Preloads credentials for Secrets Manager
// - Validates environment variables
```

#### `getCredentialsCacheStatus()`
Get current cache status for monitoring (supports both IAM tokens and credentials).

```typescript
const status = getCredentialsCacheStatus();
console.log('Credentials cache:', {
  isCached: status.credentials?.isCached,
  expiresIn: status.credentials?.timeUntilExpiry + 'ms'
});
console.log('IAM token cache:', {
  isCached: status.iamToken?.isCached,
  expiresIn: status.iamToken?.timeUntilExpiry + 'ms'
});
```

#### `getIAMTokenCacheStatus()`
Get IAM token cache status specifically.

```typescript
const iamStatus = getIAMTokenCacheStatus();
console.log('IAM token status:', {
  isCached: iamStatus.isCached,
  expiresIn: iamStatus.timeUntilExpiry + 'ms',
  isExpired: iamStatus.isExpired
});
```

#### `refreshCredentials()`
Force refresh of cached credentials or IAM tokens.

```typescript
const success = await refreshCredentials();
console.log('Refresh successful:', success);

// Automatically detects and refreshes the appropriate method:
// - IAM tokens for IAM authentication
// - Secrets Manager credentials for SM authentication
// - Returns true for environment variables (no refresh needed)
```

#### `refreshIAMToken()`
Force refresh of IAM authentication token specifically.

```typescript
const success = await refreshIAMToken();
console.log('IAM token refresh successful:', success);
```

#### `validateDatabaseConfig()`
Validate database configuration and determine authentication method.

```typescript
const config = await validateDatabaseConfig();
console.log('Auth method:', config.source); 
// Returns: 'iam-authentication', 'secrets-manager', or 'environment-variables'
console.log('Config valid:', config.isValid);
```

### Error Logging Functions

#### `logError(data)`
Log structured errors to the database.

```typescript
await logError({
  level: 'ERROR',
  component: 'API',
  message: 'User validation failed',
  userId: event.userId,
  errorCode: 'VALIDATION_ERROR'
});
```

#### `withErrorLogging(handler, component)`
Wrap Lambda handlers with automatic error logging.

```typescript
export const handler = withErrorLogging(async (event, context) => {
  // Your handler code
  return { statusCode: 200, body: 'Success' };
}, 'API');
```

## Performance Optimizations

### 1. IAM Token Caching
IAM authentication tokens are cached in memory with smart TTL management:

- **Default TTL**: 14.5 minutes (tokens valid for 15 minutes)
- **Auto-Refresh**: Generates new tokens before expiration
- **Fallback on Error**: Uses expired token if generation fails
- **Smart Invalidation**: Clears cache on authentication errors

### 2. Credential Caching  
Secrets Manager credentials are cached with configurable TTL:

- **Default TTL**: 5 minutes
- **Cache on Error**: Uses expired cache if Secrets Manager fails
- **Smart Invalidation**: Clears cache on authentication errors

### 3. Authentication Priority
Intelligent fallback system for maximum reliability:

1. **IAM Authentication** (fastest after token is cached)
2. **Secrets Manager** (cached credentials reduce API calls)
3. **Environment Variables** (instant, no API calls)

### 4. Timeout Management
Multiple layers of timeout protection:

- **Client Timeout**: Secrets Manager client timeout
- **Operation Timeout**: Race condition pattern for hard limits
- **Retry Logic**: Configurable retry attempts with exponential backoff

### 5. Cold Start Optimization
- Call `preloadCredentials()` early in Lambda handlers
- Reduces first-request latency by warming caches
- Non-blocking - continues with fallback methods if fails

### 6. Connection Pooling
- Efficient PostgreSQL connection pooling
- Automatic error recovery and pool reset
- Connection health monitoring

## Monitoring and Debugging

### Authentication Method Detection
```typescript
const config = await validateDatabaseConfig();
console.log('Current auth method:', config.source);
// Output: 'iam-authentication', 'secrets-manager', or 'environment-variables'
```

### Cache Monitoring
```typescript
const status = getCredentialsCacheStatus();

// Monitor IAM token cache
console.log('IAM token metrics:', {
  hit: status.iamToken?.isCached,
  age: Date.now() - (status.iamToken?.cachedAt || 0),
  ttl: status.iamToken?.ttl,
  remaining: status.iamToken?.timeUntilExpiry
});

// Monitor credentials cache (Secrets Manager)
console.log('Credentials metrics:', {
  hit: status.credentials?.isCached,
  age: Date.now() - (status.credentials?.cachedAt || 0),
  ttl: status.credentials?.ttl,
  remaining: status.credentials?.timeUntilExpiry
});
```

### Error Tracking
The layer automatically logs:
- IAM token generation events
- Secrets Manager timeout events
- Authentication failures and fallbacks
- Cache invalidation events
- Database connection issues

### Common Log Messages

**IAM Authentication:**
- `"Using cached IAM authentication token"` - Token cache hit
- `"Cached IAM token expired, generating new one"` - Token refresh
- `"IAM authentication token generated and cached successfully"` - New token
- `"Failed to configure IAM authentication, falling back"` - IAM fallback

**Secrets Manager:**
- `"Using cached database credentials from Secrets Manager"` - Credentials cache hit
- `"Cached credentials expired, fetching new ones"` - Credentials refresh
- `"Using expired cached credentials due to Secrets Manager failure"` - Graceful degradation

**Fallback System:**
- `"Using RDS IAM authentication for database connection (default method)"` - IAM primary
- `"Successfully retrieved credentials from Secrets Manager"` - SM fallback
- `"Using environment variables for database configuration (final fallback)"` - Env fallback

## Best Practices

### 1. Environment Configuration

**Production (Recommended):**
```bash
# IAM Authentication - Most Secure
DB_USER=iam_prod_user
DB_HOST=prod-cluster.cluster-xxxxx.region.rds.amazonaws.com
DB_NAME=production_db
DB_IAM_TOKEN_TTL=870000  # 14.5 minutes

# Optional: Secrets Manager as fallback
DB_SECRET_ARN=arn:aws:secretsmanager:region:account:secret:prod-db-secret
```

**Development:**
```bash
# Environment variables for local development
DB_USER=dev_user
DB_HOST=localhost
DB_NAME=dev_db
DB_PASSWORD=dev_password
DB_PORT=5432
```

**Staging:**
```bash
# IAM with shorter TTL for testing
DB_USER=iam_staging_user
DB_HOST=staging-cluster.cluster-xxxxx.region.rds.amazonaws.com
DB_NAME=staging_db
DB_IAM_TOKEN_TTL=300000  # 5 minutes for faster rotation testing
```

### 2. Security Best Practices

```typescript
// ✅ DO: Use IAM authentication in production
const config = await validateDatabaseConfig();
if (config.source === 'iam-authentication') {
  console.log('✅ Using secure IAM authentication');
} else {
  console.warn('⚠️ Not using IAM authentication:', config.source);
}

// ✅ DO: Monitor authentication method
const status = getCredentialsCacheStatus();
if (status.iamToken?.isCached) {
  console.log('🔐 IAM token cached, secure connection ready');
}

// ✅ DO: Handle authentication gracefully
try {
  const result = await executeQuery(sql, params);
} catch (error) {
  if (error.message.includes('authentication')) {
    // Clear caches and retry
    await refreshCredentials();
  }
}
```

### 3. Error Handling
```typescript
try {
  const result = await executeQuery(sql, params);
  if (!result.success) {
    // Handle database errors
    await logError({
      level: 'ERROR',
      component: 'DATABASE',
      message: 'Query failed',
      errorCode: 'DB_QUERY_ERROR'
    });
  }
} catch (error) {
  // Handle connection errors
  console.error('Database connection failed:', error);
  
  // Check authentication method for context
  const config = await validateDatabaseConfig();
  console.log('Auth method during error:', config.source);
}
```

### 4. Performance Tuning

```typescript
// ✅ DO: Preload for high-traffic functions
export const handler = async (event, context) => {
  await preloadCredentials();  // Reduces latency
  
  // Monitor cache performance
  const cache = getCredentialsCacheStatus();
  if (!cache.iamToken?.isCached && !cache.credentials?.isCached) {
    console.warn('⚠️ No cached credentials, may experience latency');
  }
  
  // Your database operations
};

// ✅ DO: Monitor and adjust TTL based on usage
const iamStatus = getIAMTokenCacheStatus();
if (iamStatus.timeUntilExpiry < 60000) { // Less than 1 minute
  console.log('🔄 IAM token expiring soon, will refresh automatically');
}
```

### 5. Migration Strategy

**From Environment Variables to IAM:**
```typescript
// Step 1: Add IAM setup while keeping existing vars
DB_USER=iam_user              // New: IAM user
DB_HOST=your-rds-host         // Existing
DB_NAME=your_db               // Existing  
DB_PASSWORD=fallback_password // Keep as fallback during migration

// Step 2: Verify IAM is working
const config = await validateDatabaseConfig();
console.log('Auth method:', config.source); // Should be 'iam-authentication'

// Step 3: Remove DB_PASSWORD after verification
```

## Migration Guide

This update is **backward compatible**. Existing code will work unchanged with enhanced security and performance.

### Zero-Change Migration (Automatic IAM)
If you already have these environment variables, IAM authentication will be used automatically:
```bash
DB_USER=your_user
DB_HOST=your_host  
DB_NAME=your_db
# DB_PASSWORD can be removed after IAM setup
```

**Required Steps:**
1. Create IAM database user: `CREATE USER your_user; GRANT rds_iam TO your_user;`
2. Ensure Lambda has `rds-db:connect` permission (already in template.yaml)
3. Deploy - IAM authentication will be used automatically!

### Minimal Changes (Recommended)
```typescript
// Add this line to your existing handlers for optimal performance
await preloadCredentials();

// Existing code works unchanged with better security
const result = await executeQuery('SELECT * FROM users');

// Optional: Monitor authentication method
const config = await validateDatabaseConfig();
console.log('Using:', config.source); // 'iam-authentication', 'secrets-manager', or 'environment-variables'
```

### Full Optimization
```typescript
export const handler = withErrorLogging(async (event, context) => {
  // Preload for optimal performance
  await preloadCredentials();
  
  // Monitor cache for debugging
  const cache = getCredentialsCacheStatus();
  console.log('IAM token cached:', cache.iamToken?.isCached);
  console.log('Auth method:', (await validateDatabaseConfig()).source);
  
  // Your existing database code works unchanged
  const result = await executeQuery('SELECT * FROM users');
  
  return { statusCode: 200, body: JSON.stringify(result.data) };
}, 'API');
```

### Migration Scenarios

**Scenario 1: Currently using environment variables**
```bash
# Before
DB_PASSWORD=your_password  # Will be used as final fallback

# After (add these)
DB_USER=iam_user          # Create this user with rds_iam role
```

**Scenario 2: Currently using Secrets Manager**  
```bash
# Before
DB_SECRET_ARN=arn:aws:secretsmanager:...  # Will be used as fallback

# After (add these for IAM primary)
DB_USER=iam_user
DB_HOST=your_host
DB_NAME=your_db
```

**Scenario 3: New project**
```bash
# Recommended setup (IAM only)
DB_USER=iam_user
DB_HOST=your-rds-cluster.cluster-xxxxx.region.rds.amazonaws.com
DB_NAME=your_database
DB_PORT=5432
```

## Troubleshooting

### IAM Authentication Issues

**Issue: IAM authentication not being used**
```bash
# Check logs for: "IAM authentication requirements not met"
# Solution: Ensure all required variables are set
DB_USER=iam_user
DB_HOST=your-rds-host
DB_NAME=your_database
```

**Issue: Database user doesn't exist**
```sql
-- Error: "password authentication failed for user 'iam_user'"
-- Solution: Create the IAM user in your database
CREATE USER iam_user;
GRANT rds_iam TO iam_user;
GRANT [your_permissions] TO iam_user;
```

**Issue: IAM permission denied**
```bash
# Error: "Access denied for user"
# Solution: Ensure Lambda has rds-db:connect permission
# This should already be in your template.yaml:
```
```yaml
- PolicyName: RDSAccessPolicy
  PolicyDocument:
    Version: "2012-10-17"
    Statement:
      - Effect: Allow
        Action: rds-db:connect
        Resource: "*"
```

**Issue: IAM token generation fails**
```bash
# Check logs for: "Failed to configure IAM authentication"
# Solution: Verify RDS endpoint is correct and accessible
# The layer will automatically fallback to Secrets Manager or env vars
```

### General Issues

**Issue: Still getting timeouts**
**Solution**: Reduce timeout values
```bash
DB_SECRETS_TIMEOUT=2000      # Reduce from 3000 to 2000ms
DB_IAM_TOKEN_TTL=600000      # Reduce to 10 minutes if needed
```

**Issue: Too many API calls**
**Solution**: Increase cache TTL
```bash
DB_CREDENTIALS_TTL=900000    # Increase to 15 minutes
DB_IAM_TOKEN_TTL=900000      # Increase IAM token cache
```

**Issue: Authentication errors after credential rotation**
**Solution**: Force refresh
```typescript
// Force refresh after rotation
await refreshCredentials();

// Or refresh IAM tokens specifically
await refreshIAMToken();
```

**Issue: Lambda cold starts are slow**
**Solution**: Use preload optimization
```typescript
export const handler = async (event, context) => {
  await preloadCredentials();  // Add this line
  // ... rest of handler
};
```

### Debugging Commands

```typescript
// Check authentication method being used
const config = await validateDatabaseConfig();
console.log('Auth method:', config.source);
console.log('Config valid:', config.isValid);

// Check cache status
const cache = getCredentialsCacheStatus();
console.log('IAM token cache:', cache.iamToken);
console.log('Credentials cache:', cache.credentials);

// Check IAM token specifically
const iamStatus = getIAMTokenCacheStatus();
console.log('IAM token status:', iamStatus);

// Force refresh if needed
const refreshed = await refreshCredentials();
console.log('Refresh successful:', refreshed);
```

## Support

For issues or questions:

### 1. Check Authentication Method
```typescript
const config = await validateDatabaseConfig();
console.log('Current auth method:', config.source);
console.log('Config is valid:', config.isValid);
```

### 2. Monitor Cache Performance  
```typescript
const cache = getCredentialsCacheStatus();
console.log('IAM token cached:', cache.iamToken?.isCached);
console.log('Credentials cached:', cache.credentials?.isCached);
```

### 3. Review Common Issues
- Verify IAM database user exists with `rds_iam` role
- Ensure Lambda has `rds-db:connect` permission
- Check environment variables are set correctly
- Monitor logs for fallback/timeout messages

### 4. Performance Monitoring
- Monitor cache hit/miss ratios using `getCredentialsCacheStatus()`
- Track authentication method distribution in logs
- Adjust TTL values based on usage patterns

### 5. Security Checklist
- ✅ IAM authentication enabled (check logs for "Using RDS IAM authentication")
- ✅ No passwords in environment variables (use IAM or Secrets Manager)
- ✅ Appropriate cache TTL for your security requirements
- ✅ Monitor for authentication failures and fallbacks

---

📖 **See also**: [Detailed IAM Authentication Guide](./README_IAM_AUTHENTICATION.md) for comprehensive setup instructions.
