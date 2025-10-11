import { ApiResponse } from 'wdr-models';
import { executeQuery, insertRecord, updateRecord } from 'wdr-connect-db';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { parse } from 'csv-parse/sync';

const s3 = new S3Client({ region: process.env.AWS_REGION });

const resourceFolder = 'masterdata';
const fileExtension = '.csv';

// Helper function to safely parse a string as JSON
const tryParseJSON = (jsonString) => {
    if (typeof jsonString !== 'string' || !jsonString.trim().startsWith('{') && !jsonString.trim().startsWith('[')) {
        return jsonString;
    }
    try {
        const parsed = JSON.parse(jsonString);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed;
        }
    } catch (e) {
        // Not valid JSON, return original string
    }
    return jsonString;
};

export const handler = async (event) => {
    const tableName = event.name;
    if (!tableName && tableName.trim() === "") {
        return new ApiResponse(false, null, 'Table name is required', null);
    }

    const bucketName = process.env.BUCKET_NAME;
    const fileName = `${resourceFolder}/${tableName}${fileExtension}`;

    try {
        // Check if file exists before attempting to get it
        const fileExists = await isResourceExisted(fileName, bucketName);
        if (!fileExists) {
            return new ApiResponse(false, null, `File ${fileName} not found in bucket ${bucketName}`);
        }

        // Get the file from S3
        const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: fileName
        });

        const response = await s3.send(getCommand);
        let csvContent = await response.Body.transformToString('utf-8');

        // Check for empty content
        if (!csvContent || csvContent.trim().length === 0) {
            console.log('S3 file is empty');
            return new ApiResponse(false, null, `File ${fileName} empty`);
        }

        // Parse the CSV string with the sync API
        let records = parse(csvContent, {
            columns: true, // Use the first row as column headers
            skip_empty_lines: true,
            quote: '"'
        });

        if (records.length === 0) {
            console.log('No records to import');
            return new ApiResponse(false, null, `No row to import`);
        }

        // Process CSV content here
        console.log(`Successfully retrieved file ${fileName}`);

        let insertCount = 0;
        let updateCount = 0;
        let errorCount = 0;

        const headers = Object.keys(records[0]);
        const idColumn = headers[0];

        const recordIds = [];
        const processedRecords = [];

        records.forEach(record => {
            const newRecord = {};
            for (const key in record) {
                if (Object.hasOwnProperty.call(record, key)) {
                    let value = record[key];

                    // Convert CSV null representations to actual null
                    if (value === 'NULL' || value === 'null' || value === '') {
                        newRecord[key] = null;
                    } else {
                        newRecord[key] = tryParseJSON(value);
                    }
                }
            }
            
            // Add the id value to your recordIds array
            if (newRecord[idColumn] !== undefined) {
                 recordIds.push(newRecord[idColumn]);
            }
            
            processedRecords.push(newRecord);
        });

        records = null;

        // Check all existing records at once
        const existsResult = await executeQuery(
            `SELECT "${idColumn}" FROM "${tableName}" WHERE "${idColumn}" = ANY($1)`,
            [recordIds]
        );

        if (!existsResult.success) {
            return new ApiResponse(false, null, 'Error checking existing records', existsResult.error);
        }

        const existingIds = new Set(existsResult.data.map(row => row[idColumn]));

        // Process records based on existence
        for (const record of processedRecords) {
            console.log(`Processing record with ${idColumn} = ${record[idColumn]}`);
            console.log(`Record: `, JSON.stringify(record, null, 2));
            const recordId = record[idColumn];

            if (existingIds.has(recordId)) {
                // Update existing record
                const updateResult = await updateRecord(tableName, record, { [idColumn]: recordId });
                if (updateResult.success) updateCount++;
                else errorCount++;
            } else {
                // Insert new record
                const insertResult = await insertRecord(tableName, record);
                if (insertResult.success) insertCount++;
                else errorCount++;
            }
        }

        return new ApiResponse(true, {
            inserted: insertCount,
            updated: updateCount,
            errors: errorCount,
            total: insertCount + updateCount,
            tableName: tableName
        }, `Processed ${insertCount + updateCount} records`);


    } catch (error) {
        console.error('Error processing file:', error);
        return new ApiResponse(false, null, 'Error processing file', error.message);
    }
}

/**
 * Checks if a file exists in S3
 * @param {string} objectKey - File key to check
 * @param {string} bucketName - S3 bucket name
 * @returns {boolean} True if file exists
 */
async function isResourceExisted(objectKey, bucketName) {
    try {
        console.log(`Checking if file ${objectKey} exists in bucket ${bucketName}`);

        await s3.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: objectKey
        }));

        console.log(`File ${objectKey} exists: true`);
        return true;
    } catch (error) {
        if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
            console.log(`File ${objectKey} exists: false`);
            return false;
        }
        console.error(`Error checking if file ${objectKey} exists:`, error);
        throw error;
    }
}