# WDR Content XML to PDF Converter

## Overview
AWS Lambda function that converts XML content stored in a database to PDF format with professional formatting and comprehensive error handling.

## Features
- **Enhanced XML Parsing**: Robust XML parsing with comprehensive validation
- **Professional PDF Generation**: Multi-page support with proper formatting, fonts, and layout
- **Metadata Support**: Optional inclusion of document metadata in the PDF
- **Error Handling**: Comprehensive error handling following WDR patterns
- **Configurable Options**: Customizable PDF generation options via query parameters
- **Database Integration**: Seamless integration with WDR database layer

## API Endpoints

### Convert XML to PDF
- **Method**: GET
- **Path**: `/content/{id}/pdf` or `/content/pdf?id={contentId}`
- **Query Parameters**:
  - `id` (required): Content ID from the database
  - `fontSize` (optional): Font size for PDF content (default: 10)
  - `includeMetadata` (optional): Include XML metadata in PDF (default: false)

### Request Examples
```bash
# Using path parameter
GET /content/12345/pdf

# Using query parameter with options
GET /content/pdf?id=12345&fontSize=12&includeMetadata=true
```

### Response Format
```json
{
  "success": true,
  "data": {
    "pdfData": "base64-encoded-pdf-content",
    "contentId": "12345",
    "title": "Report Title",
    "generatedAt": "2025-07-25T10:30:00.000Z"
  },
  "message": "PDF generated successfully for content: Report Title",
  "error": 200
}
```

## Error Responses
- **400 Bad Request**: Missing or invalid content ID
- **404 Not Found**: Content not found in database
- **500 Internal Server Error**: XML parsing or PDF generation errors

## Technical Details

### Dependencies
- `pdf-lib`: Advanced PDF generation with professional formatting
- `xml2js`: Robust XML parsing with configuration options
- `wdr-connect-db`: Database connectivity layer
- `wdr-models`: Standardized response models
- `wdr-error-codes`: Centralized error code management

### Database Schema
The function expects a `report` table with the following structure:
```sql
SELECT r.id, r.content, r.title, r.created_at, r.updated_at, u.name as created_by
FROM report r
LEFT JOIN users u ON r.created_by_user_id = u.id
WHERE r.id = $1 AND r.content IS NOT NULL
```

### PDF Features
- **Multi-page Support**: Automatic page breaks and content overflow handling
- **Professional Fonts**: Helvetica for body text, Helvetica Bold for headers, Courier Bold for code
- **Structured Layout**: Title, metadata section, original XML content, and parsed JSON data
- **Text Wrapping**: Intelligent text wrapping for long lines
- **XML Formatting**: Proper indentation and formatting of XML content

## Configuration

### PDF Generation Options
```typescript
interface PdfGenerationOptions {
  title?: string;           // PDF document title
  author?: string;          // PDF document author
  subject?: string;         // PDF document subject
  fontSize?: number;        // Base font size (default: 10)
  includeMetadata?: boolean; // Include XML metadata section
  margin?: {                // Page margins
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  pageSize?: [number, number]; // Page size (default: A4)
}
```

## Development

### Build Commands
```bash
# Development build
npm run build:dev

# Production build
npm run build

# Run tests
npm run test

# Watch mode for tests
npm run test:watch

# Lint code
npm run lint

# Clean build artifacts
npm run clean
```

### Project Structure
```
wdr-content-xml-to-pdf/
├── src/
│   ├── index.ts              # Main Lambda handler
│   ├── services/
│   │   ├── xmlParser.ts      # XML parsing logic
│   │   └── pdfGenerator.ts   # PDF generation logic
│   ├── utils/
│   │   └── helpers.ts        # Utility functions
│   └── types/
│       └── index.ts          # Type definitions
├── package.json
├── tsconfig.json
└── README.md
```

## Error Handling
The function implements comprehensive error handling:
- **Input Validation**: Validates content ID and XML structure
- **Database Errors**: Handles database connection and query failures
- **XML Parsing Errors**: Provides detailed XML parsing error messages
- **PDF Generation Errors**: Handles PDF creation and formatting errors
- **Resource Management**: Proper cleanup and memory management

## Security Considerations
- Input sanitization for content IDs
- XML validation to prevent malformed content processing
- Memory-efficient PDF generation for large XML files
- Error message sanitization to prevent information disclosure

## Performance
- Efficient XML parsing with streaming for large files
- Memory-optimized PDF generation
- Minimal dependencies for fast cold starts
- Proper resource cleanup and garbage collection
