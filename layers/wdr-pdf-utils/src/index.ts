// Layer entry point - exports all PDF and XML utilities
export * from './pdfGenerator';
export * from './xmlParser';
export * from './types';

// Re-export commonly used functions with descriptive names
export { generatePdf as createPdfFromContent } from './pdfGenerator';
export { parseXml as parseXmlContent, validateXmlStructure, extractXmlMetadata } from './xmlParser';
