import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery } from 'wdr-connect-db';
import { parseXml, generatePdf, PdfGenerationOptions } from 'wdr-pdf-utils';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { ERROR_CODES } from 'wdr-error-codes';

interface ReportContent {
  id: string;
  content: string;
  title?: string;
  created_at?: Date;
  updated_at?: Date;
  created_by?: string;
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const queryParams = event.queryStringParameters || {};
    const pathParams = event.pathParameters || {};
    
    // Extract content ID from path parameters or query string parameters
    const contentId = pathParams.id || queryParams.id;
    
    if (!contentId) {
      return LambdaResponse.error(new ApiResponse(false, null, 'Content ID parameter is required', ERROR_CODES.BAD_REQUEST.code));
    }

    // Query content by ID with additional metadata
    const sql = `
      SELECT r.id, r.content, r.title, r.created_at, r.updated_at, u.name as created_by
      FROM report r
      LEFT JOIN users u ON r.created_by_user_id = u.id
      WHERE r.id = $1 AND r.content IS NOT NULL
    `;
    
    const result = await executeQuery(sql, [contentId]);
    
    if (!result || result.rowCount === 0) {
      return LambdaResponse.error(new ApiResponse(false, null, 'No content found with the specified ID', ERROR_CODES.NOT_FOUND.code));
    }

    const reportContent: ReportContent = result.data[0];
    
    // Parse XML content to JSON
    const parsedData = await parseXml(reportContent.content);
    
    // Configure PDF generation options
    const pdfOptions: PdfGenerationOptions = {
      title: reportContent.title || 'Report Content',
      author: reportContent.created_by || 'System',
      subject: `Report generated from content ID: ${contentId}`,
      createdAt: reportContent.created_at,
      fontSize: parseInt(queryParams.fontSize || '10'),
      includeMetadata: queryParams.includeMetadata !== 'false', // Default to true
      includeJsonData: queryParams.includeJsonData === 'true', // Default to false
      margin: parseInt(queryParams.margin || '50')
    };
    
    // Generate PDF from parsed XML data
    const pdfBuffer = await generatePdf(
      JSON.stringify(parsedData, null, 2), // Convert parsed data to formatted string
      { // metadata
        id: reportContent.id,
        title: reportContent.title,
        created_at: reportContent.created_at,
        created_by: reportContent.created_by
      },
      pdfOptions,
      parsedData // Include original parsed data as JSON section
    );

    // Return PDF as base64 encoded string for API Gateway
    const response = {
      pdfData: Buffer.from(pdfBuffer).toString('base64'),
      contentId: contentId,
      title: reportContent.title,
      generatedAt: new Date().toISOString()
    };

    return LambdaResponse.success(new ApiResponse(true, response, `PDF generated successfully for content: ${reportContent.title || contentId}`, 200));
  } catch (error) {
    console.error('Error in wdr-content-xml-to-pdf:', error);
    return LambdaResponse.error(new ApiResponse(false, null, 'An error occurred while generating the PDF', ERROR_CODES.INTERNAL_SERVER_ERROR.code));
  }
};