# ServerlessApp

A serverless backend application built with AWS SAM (Serverless Application Model) and TypeScript, designed for managing projects, reports, trade sections, and users. The application uses AWS Lambda, API Gateway, and PostgreSQL, with shared code organized in Lambda Layers.

## Directory Structure

```
src/
  functions/
    report/
      report_create_new_template/
      .../
    trade-section/
      trade-section-create/
      ... /
    .../
layers/
  api-model/
  db/
  error-code/
```
## AWS SAM Template

The `template.yaml` defines:
- API Gateway
- Lambda Functions (with shared layers)
- Lambda Layers
- RDS connection parameters (as environment variables)
- Other AWS resources (S3, CloudWatch, etc.)

## Development

### Prerequisites

- Node.js 22.x
- AWS SAM CLI
- PostgreSQL database

### Install Dependencies

```sh
npm install
```

### Build and Deploy

```sh
npm run build

sam build
sam deploy --guided
```

### Environment Variables

Set in `template.yaml` under `Globals.Function.Environment.Variables`:
- `DB_HOST`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_PORT`

## Scripts

- `npm run build` – Build the project using `build.js`.
