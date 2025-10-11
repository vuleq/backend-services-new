# WDR Newsource - Build and Deployment Guide

## Overview
WDR Backend service is a serverless microservices application built with AWS SAM (Serverless Application Model). It features optimized Lambda layers for shared code and efficient function deployment.

## Prerequisites
- Node.js 22.x or later
- AWS CLI configured with appropriate permissions
- SAM CLI installed (`npm install -g @aws/sam-cli`)
- TypeScript knowledge for development

## Project Architecture
```
newsource/
├── package.json                    # Root build orchestration
├── template.yaml                   # SAM template 
├── tsconfig.json                   # Root TypeScript config with path mappings
├── layers/                         # Shared Lambda layers
│   ├── wdr-connect-db/            # Database utilities layer
│   │   ├── src/index.ts           # Database connection & query functions
│   │   ├── package.json           # Layer build configuration
│   │   ├── tsconfig.json          # Layer TypeScript config
│   │   └── nodejs/                # SAM layer output (auto-generated)
│   ├── wdr-models/                # API models layer
│   │   ├── src/index.ts           # ApiResponse, ResponsePage, LambdaResponse
│   │   ├── package.json           # Layer build configuration
│   │   ├── tsconfig.json          # Layer TypeScript config
│   │   └── nodejs/                # SAM layer output (auto-generated)
│   └── wdr-error-codes/           # Error handling layer
│       ├── src/index.ts           # ERROR_CODES, buildError function
│       ├── package.json           # Layer build configuration
│       ├── tsconfig.json          # Layer TypeScript config
│       └── nodejs/                # SAM layer output (auto-generated)
└── functions/                     # Lambda functions
    ├── users/
    │   └── wdr-user-find-by-role/ # Find users by role function
    │       ├── src/index.ts       # Lambda handler
    │       ├── package.json       # Function dependencies
    │       ├── tsconfig.json      # Development config (extends root)
    │       └── tsconfig.sam.json  # SAM build config (standalone)
    └── reports/
        └── wdr-report-get-by-id/  # Get report by ID function
            ├── src/index.ts       # Lambda handler
            ├── package.json       # Function dependencies
            ├── tsconfig.json      # Development config (extends root)
            └── tsconfig.sam.json  # SAM build config (standalone)
```

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Build Everything
```bash
npm run build
```

### 3. Deploy to AWS
```bash
# First time deployment (interactive)
npm run deploy:guided

# Subsequent deployments
npm run deploy

# Deploy specific function only (see "Specific Function Build & Deploy" section)
sam build WdrUserFindByRoleFunction && sam deploy --no-confirm-changeset
```

## Build Commands

### Complete Build Process
```bash
npm install                    # Install root dependencies
npm run build                  # Build layers + prepare for SAM
sam build                      # Build SAM application
```

### Individual Layer Builds
```bash
npm run build:layer:db         # Build database layer
npm run build:layer:models     # Build models layer  
npm run build:layer:errors     # Build error codes layer
```

### Development Builds
```bash
# Build specific function for testing
cd functions/users/wdr-user-find-by-role
npm run build

# Clean everything and rebuild
npm run clean
npm run build
```

### Local Testing
```bash
npm run local                  # Start local API Gateway
```

## Specific Function Build & Deploy

### Available Functions
- `WdrUserFindByRoleFunction` - Find users by role
- `WdrReportGetByIdFunction` - Get report by ID  

### Build Specific Functions
```bash
# Build only one function
sam build WdrUserFindByRoleFunction

# Build multiple specific functions
sam build WdrUserFindByRoleFunction WdrReportGetByIdFunction
```

### Deploy Specific Functions
```bash
# Build and deploy specific function
sam build WdrUserFindByRoleFunction
sam deploy --no-confirm-changeset

# Or combine in one command
sam build WdrUserFindByRoleFunction && sam deploy --no-confirm-changeset

# Deploy with parameters
sam build WdrUserFindByRoleFunction
sam deploy --parameter-overrides DBPassword="your-password" --no-confirm-changeset
```

### Build Optimization Tips
```bash
# If you only changed one function, build just that one
sam build WdrUserFindByRoleFunction

# If you changed layers, build everything
sam build

# Skip changeset confirmation (useful for CI/CD)
sam deploy --no-confirm-changeset --capabilities CAPABILITY_IAM
```

## Layer Development

### Layer Import Usage in Functions
```typescript
// Correct imports for development (uses path mappings)
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse, ResponsePage } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';
```

### Available Layer Functions

#### wdr-connect-db Layer
```typescript
import { executeQuery, insertRecord, updateRecord, deleteRecord, performTransaction } from 'wdr-connect-db';

// Execute raw SQL
const result = await executeQuery('SELECT * FROM users WHERE role = $1', ['admin']);

// CRUD operations
const user = await insertRecord('users', { name: 'John', role: 'admin' });
const updated = await updateRecord('users', { name: 'Jane' }, { id: 1 });
const deleted = await deleteRecord('users', { id: 1 });
```

#### wdr-models Layer
```typescript
import { ApiResponse, ResponsePage, LambdaResponse } from 'wdr-models';

// Standard API responses
const response = new ApiResponse(true, userData, 'Success');
const pagedResponse = new ResponsePage(1, 10, 100, users);
const lambdaResponse = new LambdaResponse(200, { data: users });
```

#### wdr-error-codes Layer
```typescript
import { ERROR_CODES, buildError } from 'wdr-error-codes';

// Build standardized errors
const error = buildError('MISSING_REQUIRED_FIELD', 'Custom message');
const dbError = buildError('DATABASE_ERROR');
```

## Creating New Functions

### 1. Create Function Directory
```bash
mkdir -p functions/category/function-name
cd functions/category/function-name
```

### 2. Create package.json
```json
{
  "name": "function-name",
  "version": "1.0.0",
  "description": "Function description",
  "main": "src/index.ts",
  "scripts": {
    "build": "esbuild src/index.ts --bundle --minify --sourcemap --platform=node --target=es2020 --outfile=dist/index.js --external:wdr-connect-db --external:wdr-models --external:wdr-error-codes",
    "local": "npm run build && node dist/index.js"
  },
  "dependencies": {
    "@types/aws-lambda": "^8.10.150"
  },
  "devDependencies": {
    "@types/node": "^24.0.12",
    "esbuild": "^0.25.6",
    "typescript": "^5.8.3"
  }
}
```

### 3. Create tsconfig.json (Development)
```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": [
    "src/**/*"
  ]
}
```

### 4. Create tsconfig.sam.json (SAM Build)
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "es2020",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true
  },
  "include": [
    "src/**/*"
  ]
}
```

### 5. Create src/index.ts
```typescript
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { ApiResponse } from 'wdr-models';
import { ERROR_CODES, buildError } from 'wdr-error-codes';

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Your function logic here
    const response = new ApiResponse(true, { message: 'Hello World' });
    
    return {
      statusCode: 200,
      body: JSON.stringify(response),
      headers: {
        'Content-Type': 'application/json',
      },
    };
  } catch (err: any) {
    console.error('Error:', err);
    const error = buildError('DATABASE_ERROR', err.message);
    
    return {
      statusCode: 500,
      body: JSON.stringify(new ApiResponse(false, null, 'Internal server error', error)),
      headers: {
        'Content-Type': 'application/json',
      },
    };
  }
};
```

### 6. Add to template.yaml
```yaml
  YourNewFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: your-new-function-name
      Description: Your function description
      CodeUri: functions/category/function-name/
      Layers:
        - !Ref WdrModelsLayer
        - !Ref WdrConnectDbLayer
        - !Ref WdrErrorCodesLayer
    Metadata:
      BuildMethod: esbuild
      BuildProperties:
        Minify: true
        Target: es2020
        Sourcemap: true
        EntryPoints:
          - src/index.ts
        Tsconfig: tsconfig.sam.json
        External:
          - "wdr-connect-db"
          - "wdr-models"
          - "wdr-error-codes"
```

## Creating New Layers

### 1. Create Layer Directory
```bash
mkdir -p layers/layer-name/src
cd layers/layer-name
```

### 2. Create package.json
```json
{
  "name": "layer-name",
  "version": "1.0.0",
  "description": "Layer description",
  "main": "src/index.ts",
  "scripts": {
    "build": "npm run clean && npm run compile && npm run create-package",
    "clean": "if exist nodejs rmdir /s /q nodejs",
    "compile": "tsc",
    "create-package": "node -e \"const fs = require('fs'); const path = require('path'); const dir = 'nodejs/node_modules/layer-name'; fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'layer-name', version: '1.0.0', main: 'index.js', type: 'commonjs'}, null, 2))\""
  },
  "devDependencies": {
    "@types/node": "^24.0.12",
    "typescript": "^5.8.3"
  }
}
```

### 3. Create tsconfig.json
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./nodejs/node_modules/layer-name"
  },
  "include": [
    "src/**/*"
  ]
}
```

### 4. Create src/index.ts
```typescript
// Export your layer functions
export function myLayerFunction() {
  return 'Hello from layer';
}
```

### 5. Add to template.yaml
```yaml
  YourNewLayer:
    Type: AWS::Serverless::LayerVersion
    Properties:
      LayerName: your-layer-name
      Description: Your layer description
      ContentUri: layers/layer-name/nodejs/
      CompatibleRuntimes:
        - nodejs22.x
      RetentionPolicy: Retain
    Metadata:
      BuildMethod: nodejs22.x
```

### 6. Update root tsconfig.json
```json
{
  "compilerOptions": {
    "paths": {
      "layer-name": ["layers/layer-name/src/index"]
    }
  }
}
```

## Deployment

### Environment Configuration
Set database parameters during deployment:
```bash
sam deploy --parameter-overrides \
  DBHost="your-db-host" \
  DBName="your-db-name" \
  DBUser="your-db-user" \
  DBPassword="your-secure-password"
```

### Production Deployment
For production, use AWS Secrets Manager:
```bash
# Store password in Secrets Manager first
aws secretsmanager create-secret --name "wdr/db/password" --secret-string "your-secure-password"

# Reference in template.yaml
DBPassword: !Sub "{{resolve:secretsmanager:wdr/db/password:SecretString}}"
```

## Development Tips

### 1. TypeScript Configuration
- Development uses root `tsconfig.json` with path mappings
- SAM build uses function-specific `tsconfig.sam.json` files
- This dual setup ensures both dev IntelliSense and build compatibility

### 2. Layer Testing
Test layers independently:
```bash
cd layers/wdr-connect-db
npm run build
npm test  # If you add tests
```

### 3. Local Debugging
Use SAM local for debugging:
```bash
sam local invoke WdrUserFindByRoleFunction -e events/test-event.json
```

### 4. Performance Optimization
- Only include necessary layers in functions
- Use external dependencies to reduce bundle size
- Enable minification and tree shaking

## Troubleshooting

### Build Issues
- Ensure all `npm install` commands complete successfully
- Check TypeScript compilation errors in individual layers
- Verify SAM CLI version compatibility

### Import Errors
- Development: Check root `tsconfig.json` path mappings
- Build: Verify `external` dependencies in template.yaml
- Runtime: Ensure layers are properly attached to functions

### Deployment Issues
- Check AWS credentials and permissions
- Verify parameter values in samconfig.toml
- Review CloudFormation stack events for detailed error messages