import { PDFDocument, rgb, PageSizes, StandardFonts } from 'pdf-lib';
import { PdfGenerationOptions, FormattedContent } from './types';

export const generatePdf = async (
    content: string,
    metadata: Record<string, any> = {},
    options: PdfGenerationOptions = {},
    jsonData?: any
): Promise<Uint8Array> => {
    try {
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const defaultOptions = {
            title: 'Generated PDF Report',
            author: 'WDR System',
            subject: 'XML to PDF Conversion',
            fontSize: 12,
            margin: 50,
            pageSize: PageSizes.A4,
            includeMetadata: true,
            includeJsonData: false
        };

        const finalOptions = { 
            ...defaultOptions, 
            ...options
        };
        
        // Set document metadata
        pdfDoc.setTitle(finalOptions.title);
        pdfDoc.setAuthor(finalOptions.author);
        pdfDoc.setSubject(finalOptions.subject);
        pdfDoc.setCreationDate(new Date());

        let currentPage = pdfDoc.addPage(finalOptions.pageSize);
        let yPosition = currentPage.getHeight() - finalOptions.margin;

        // Add title
        yPosition = addTitle(currentPage, finalOptions.title, boldFont, yPosition, finalOptions);

        // Add metadata section if enabled
        if (finalOptions.includeMetadata && Object.keys(metadata).length > 0) {
            yPosition = await addMetadataSection(
                pdfDoc, currentPage, metadata, font, boldFont, yPosition, finalOptions
            );
            currentPage = yPosition < finalOptions.margin ? pdfDoc.addPage(finalOptions.pageSize) : currentPage;
            if (yPosition < finalOptions.margin) {
                yPosition = currentPage.getHeight() - finalOptions.margin;
            }
        }

        // Add main content
        const result = await addContentSection(
            pdfDoc, currentPage, content, font, boldFont, yPosition, finalOptions
        );
        currentPage = result.page;
        yPosition = result.yPosition;

        // Add JSON data section if enabled and data exists
        if (finalOptions.includeJsonData && jsonData) {
            if (yPosition < finalOptions.margin + 100) {
                currentPage = pdfDoc.addPage(finalOptions.pageSize);
                yPosition = currentPage.getHeight() - finalOptions.margin;
            }

            yPosition -= 20;
            currentPage.drawText('JSON Data:', {
                x: finalOptions.margin,
                y: yPosition,
                size: finalOptions.fontSize + 2,
                font: boldFont,
                color: rgb(0, 0, 0),
            });

            yPosition -= 15;
            const jsonString = JSON.stringify(jsonData, null, 2);
            await addContentSection(
                pdfDoc, currentPage, jsonString, font, boldFont, yPosition, finalOptions
            );
        }

        return await pdfDoc.save();
    } catch (error) {
        console.error('Error generating PDF:', error);
        throw new Error(`PDF generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
};

const addTitle = (
    page: any,
    title: string,
    font: any,
    yPosition: number,
    options: any
): number => {
    const titleSize = options.fontSize + 8;
    page.drawText(title, {
        x: options.margin,
        y: yPosition,
        size: titleSize,
        font: font,
        color: rgb(0, 0, 0),
    });
    
    // Add underline
    const titleWidth = font.widthOfTextAtSize(title, titleSize);
    page.drawLine({
        start: { x: options.margin, y: yPosition - 5 },
        end: { x: options.margin + titleWidth, y: yPosition - 5 },
        thickness: 1,
        color: rgb(0, 0, 0),
    });
    
    return yPosition - 40;
};

const addMetadataSection = async (
    pdfDoc: PDFDocument,
    page: any,
    metadata: Record<string, any>,
    font: any,
    boldFont: any,
    yPosition: number,
    options: any
): Promise<number> => {
    let currentY = yPosition;
    
    // Section title
    page.drawText('Document Information:', {
        x: options.margin,
        y: currentY,
        size: options.fontSize + 2,
        font: boldFont,
        color: rgb(0, 0, 0),
    });
    currentY -= 20;

    // Add metadata items
    for (const [key, value] of Object.entries(metadata)) {
        if (currentY < options.margin) {
            page = pdfDoc.addPage(options.pageSize);
            currentY = page.getHeight() - options.margin;
        }

        const displayKey = key.charAt(0).toUpperCase() + key.slice(1);
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        
        page.drawText(`${displayKey}:`, {
            x: options.margin,
            y: currentY,
            size: options.fontSize,
            font: boldFont,
            color: rgb(0, 0, 0),
        });
        
        const keyWidth = boldFont.widthOfTextAtSize(`${displayKey}: `, options.fontSize);
        page.drawText(displayValue, {
            x: options.margin + keyWidth,
            y: currentY,
            size: options.fontSize,
            font: font,
            color: rgb(0.2, 0.2, 0.2),
        });
        
        currentY -= 18;
    }
    
    return currentY - 10;
};

const addContentSection = async (
    pdfDoc: PDFDocument,
    page: any,
    content: string,
    font: any,
    boldFont: any,
    yPosition: number,
    options: any
): Promise<{ page: any; yPosition: number }> => {
    let currentPage = page;
    let currentY = yPosition;
    
    // Section title
    currentPage.drawText('Content:', {
        x: options.margin,
        y: currentY,
        size: options.fontSize + 2,
        font: boldFont,
        color: rgb(0, 0, 0),
    });
    currentY -= 25;

    // Format and add content
    const formattedContent = formatXmlForPdf(content);
    const pageWidth = currentPage.getWidth() - (options.margin * 2);
    
    for (const section of formattedContent) {
        if (currentY < options.margin) {
            currentPage = pdfDoc.addPage(options.pageSize);
            currentY = currentPage.getHeight() - options.margin;
        }

        const lines = wrapText(section.text, font, section.fontSize, pageWidth);
        
        for (const line of lines) {
            if (currentY < options.margin) {
                currentPage = pdfDoc.addPage(options.pageSize);
                currentY = currentPage.getHeight() - options.margin;
            }

            currentPage.drawText(line, {
                x: options.margin + section.indent,
                y: currentY,
                size: section.fontSize,
                font: section.bold ? boldFont : font,
                color: section.color,
            });
            
            currentY -= section.fontSize + 4;
        }
        
        currentY -= section.spacing;
    }
    
    return { page: currentPage, yPosition: currentY };
};

const formatXmlForPdf = (xmlContent: string): FormattedContent[] => {
    const sections: FormattedContent[] = [];
    const lines = xmlContent.split('\n');
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        let fontSize = 11;
        let bold = false;
        let indent = 0;
        let color = rgb(0, 0, 0);
        let spacing = 2;
        
        // Detect XML elements and format accordingly
        if (trimmedLine.startsWith('<?xml')) {
            fontSize = 10;
            color = rgb(0.6, 0.6, 0.6);
        } else if (trimmedLine.startsWith('</')) {
            // Closing tag
            indent = (line.length - line.trimLeft().length) * 3;
            color = rgb(0.8, 0.2, 0.2);
            fontSize = 10;
        } else if (trimmedLine.startsWith('<') && trimmedLine.includes('>')) {
            // Opening tag or self-closing
            indent = (line.length - line.trimLeft().length) * 3;
            if (trimmedLine.match(/<[^>]*>/)) {
                color = rgb(0.2, 0.4, 0.8);
                fontSize = 10;
                if (!trimmedLine.includes('</')) {
                    bold = true; // Opening tags are bold
                }
            }
        } else {
            // Text content
            indent = (line.length - line.trimLeft().length) * 3 + 10;
            color = rgb(0.1, 0.1, 0.1);
            spacing = 1;
        }
        
        sections.push({
            text: trimmedLine,
            fontSize,
            bold,
            indent: Math.min(indent, 200), // Limit maximum indent
            color,
            spacing
        });
    }
    
    return sections;
};

const wrapText = (text: string, font: any, fontSize: number, maxWidth: number): string[] => {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    
    for (const word of words) {
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);
        
        if (testWidth <= maxWidth) {
            currentLine = testLine;
        } else {
            if (currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                // Single word is too long, add it anyway
                lines.push(word);
            }
        }
    }
    
    if (currentLine) {
        lines.push(currentLine);
    }
    
    return lines.length > 0 ? lines : [''];
};
