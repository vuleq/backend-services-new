import AWS from 'aws-sdk';
import { executeQuery } from 'wdr-connect-db';
import { LambdaResponse, ApiResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';

const s3 = new AWS.S3();

export const handler = async (event) => {
    console.log('=== Database Import Lambda Started ===');
    console.log('Event:', JSON.stringify(event, null, 2));
    const fileName = event.queryStringParameters?.file;

    try {
        const s3Bucket = process.env.S3_BUCKET;
        const s3Key = `masterdata/${fileName}`

        if (!fileName) {
            return new LambdaResponse(400, new ApiResponse(false, 'File name is required', null));
        }

        if (!/^[\w\-\.]+\.sql$/.test(fileName)) {
            return new LambdaResponse(400, new ApiResponse(false, 'Invalid file name', null));
        }

        console.log(`Reading SQL file from S3: s3://${s3Bucket}/${s3Key}`);
        let s3Response;
        try {
            s3Response = await s3.getObject({
                Bucket: s3Bucket,
                Key: s3Key
            }).promise();

        } catch (error) {
            console.log('Error reading SQL file from S3:', error);
            if (error.code === 'NoSuchKey' || error.code === 'NotFound') {
                return new LambdaResponse(404, new ApiResponse(false, `File ${fileName} not found in S3`, null));
            }
        }


        const sqlContent = s3Response.Body.toString('UTF8');
        console.log(`SQL file read successfully, size: ${sqlContent.length} characters`);

        // Split SQL content into individual statements
        const statements = sqlContent
            .split(';')
            .map(stmt => stmt.trim())
            .filter(stmt => stmt.length > 0 && !stmt.startsWith('--') && !stmt.startsWith('/*'));

        console.log(`Found ${statements.length} SQL statements to execute`);

        // Execute each statement
        let successCount = 0;
        let errorCount = 0;
        const errors = [];

        for (let i = 0; i < statements.length; i++) {
            const statement = statements[i];
            if (statement.trim()) {
                console.log(`Executing statement ${i + 1}/${statements.length}`);
                const executeRes = await executeQuery(statement);
                console.log(executeQuery)

                if (executeRes.success) {
                    console.log(`Statement ${i + 1} executed successfully`);
                    successCount++;
                }
                else {
                    console.log(`Error executing statement ${i + 1}:`, executeRes.error);
                    errors.push({
                        statement: i + 1,
                        error: executeRes.error,
                        sql: statement.substring(0, 100) + '...'
                    });
                    errorCount++;
                }
            }
        }

        console.log('=== Database Import Summary ===');
        console.log(`Successfully executed: ${successCount} statements`);
        console.log(`Failed statements: ${errorCount}`);
        console.log(`Total statements: ${statements.length}`);

        if (errors.length > 0) {
            console.log('Errors encountered:');
            errors.forEach(err => {
                console.log(`  - Statement ${err.statement}: ${err.error}`);
            });
        }

        return new LambdaResponse(200, new ApiResponse(true, {
            totalStatements: statements.length,
            successfulStatements: successCount,
            failedStatements: errorCount,
            successRate: `${((successCount / statements.length) * 100).toFixed(2)}%`,
            errors: errors.length > 0 ? errors : null
        }, 'Database import completed'));

    } catch (error) {
        console.log('Fatal error during database import:', error);
        return new LambdaResponse(500, new ApiResponse(false, { errors: error.message }, 'Database import failed'));
    }
}; 