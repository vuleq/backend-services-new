import { UUID } from 'crypto';

export type XmlContent = {
    [key: string]: any;
};

export type ParsedXmlData = {
    [key: string]: any;
};

export type PdfGenerationOptions = {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
    createdAt?: Date;
    fontSize?: number;
    includeMetadata?: boolean;
    includeJsonData?: boolean;
    margin?: number; // Simple margin for all sides
    pageSize?: [number, number];
};

export type FormattedContent = {
    text: string;
    fontSize: number;
    bold: boolean;
    indent: number;
    color: any; // RGB object from pdf-lib
    spacing: number;
};

export type XmlParsingOptions = {
    explicitArray?: boolean;
    ignoreAttrs?: boolean;
    mergeAttrs?: boolean;
    trim?: boolean;
    normalize?: boolean;
    normalizeTags?: boolean;
    explicitRoot?: boolean;
};

export type PdfResponse = {
    pdfData: string;
    contentId: string;
    title?: string;
    generatedAt: string;
};

export type XmlMetadata = {
    [key: string]: any;
};
