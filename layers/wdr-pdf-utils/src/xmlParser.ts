import * as xml2js from 'xml2js';
import { ParsedXmlData, XmlParsingOptions, XmlMetadata } from './types';

export const parseXml = async (
    xmlContent: string, 
    options: XmlParsingOptions = {}
): Promise<ParsedXmlData> => {
    try {
        if (!xmlContent || typeof xmlContent !== 'string') {
            throw new Error('Invalid XML content provided');
        }

        // Trim whitespace and validate basic XML structure
        const trimmedXml = xmlContent.trim();
        if (!trimmedXml.startsWith('<') || !trimmedXml.includes('>')) {
            throw new Error('Content does not appear to be valid XML');
        }

        const defaultOptions: XmlParsingOptions = {
            explicitArray: false,
            ignoreAttrs: false,
            mergeAttrs: true,
            trim: true,
            normalize: true,
            normalizeTags: true,
            explicitRoot: true
        };

        const parserOptions = { ...defaultOptions, ...options };
        const parser = new xml2js.Parser(parserOptions);

        return new Promise((resolve, reject) => {
            parser.parseString(trimmedXml, (err, result) => {
                if (err) {
                    console.error('XML parsing error:', err);
                    reject(new Error(`Failed to parse XML content: ${err.message}`));
                } else {
                    resolve(result);
                }
            });
        });
    } catch (error) {
        console.error('Error in parseXml:', error);
        throw new Error(`XML parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
};

export const validateXmlStructure = (xmlContent: string): boolean => {
    try {
        const trimmed = xmlContent.trim();
        return trimmed.startsWith('<') && trimmed.includes('>') && trimmed.length > 0;
    } catch {
        return false;
    }
};

export const extractXmlMetadata = (parsedData: ParsedXmlData): XmlMetadata => {
    const metadata: XmlMetadata = {};
    
    // Extract common metadata fields if they exist
    if (parsedData.root) {
        const root = parsedData.root;
        if (root.title) metadata.title = root.title;
        if (root.created) metadata.created = root.created;
        if (root.author) metadata.author = root.author;
        if (root.version) metadata.version = root.version;
        if (root.description) metadata.description = root.description;
        if (root.subject) metadata.subject = root.subject;
    }
    
    // Try to extract from other common root elements
    const rootKeys = Object.keys(parsedData);
    if (rootKeys.length > 0) {
        const firstRoot = parsedData[rootKeys[0]];
        if (typeof firstRoot === 'object' && firstRoot !== null) {
            if (firstRoot.title) metadata.title = firstRoot.title;
            if (firstRoot.created) metadata.created = firstRoot.created;
            if (firstRoot.author) metadata.author = firstRoot.author;
            if (firstRoot.version) metadata.version = firstRoot.version;
        }
    }
    
    return metadata;
};
