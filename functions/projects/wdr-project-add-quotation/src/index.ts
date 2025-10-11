import { executeQuery, performTransaction, TransactionResult, Operation } from 'wdr-connect-db';
import { isValidUUID, isValidCognitoSub } from 'wdr-common-utils';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3Event, S3EventRecord, Handler } from 'aws-lambda';
import { Workbook, Worksheet, Row } from 'wdr-exceljs-layer';

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const projectStatus = {
    'Not started': 0,
    Started: 1,
    Completed: 2,
    Closed: 3
};

const jobStatus = {
    Draft: 0,
    Confirmed: 1,
    Cancelled: 2,
    Started: 3,
    Completed: 4
}

const jobTypeEnum = {
    'Main': 0,
    'Support': 1,
    'AWRF': 2
}

const headerRow = [`Item No.`, `Description`, `Qty`, `UOM`];
const sheetName = 'Quotation';

// Status messages constants
const JOB_STATUS_MESSAGES = {
    DUPLICATE: 'Duplicate Title in File',
    EXISTS: 'Job Already Exists',
    CREATED: 'Job Created',
    FAILED: 'Failed to Create Job'
};

const roleEnum = {
    'Super User': 0,
    'SRM': 1,
    'Safety Officer': 2,
    'Commercial Officer Admin': 3,
    'Commercial Officer': 4
};

const projectStatusName = Object.fromEntries(
    Object.entries(projectStatus).map(([name, id]) => [id, name])
);

const s3Folder = {
    compress: 'compress', // All upload image are compress to this folder
    results: 'results' // Current only store project quotation result file
}

interface ExtractedJob {
    title: string;
    description: string;
    rowIndex: number;
}

interface ProjectDate {
    plan_start_date: Date | null;
    plan_complete_date: Date | null;
    actual_start_date: Date | null;
    actual_complete_date: Date | null;
}

export const handler: Handler<S3Event> = async (event) => {
    console.log('S3 Event: ', JSON.stringify(event, null, 2));

    try {
        // Upload each file so only process 1st file
        const s3Record = await processS3Record(event.Records[0]);

        const { bucket, key, fileName, Body, ContentType, Metadata, projectId, userId } = s3Record;
        const { projectDate, quotationLinks } = await validateProject(projectId);

        const { workbook, worksheet } = await processExcelWorkbook(Body, fileName, projectId, quotationLinks);
        const jobOperationResult = await executeJobOperations(worksheet, projectId, projectDate, userId, quotationLinks);

        await saveProcessedFile(workbook, bucket, jobOperationResult.newQuotationLink, ContentType, Metadata, jobOperationResult.jobs, key);

        return { statusCode: 200, body: 'Processing completed' };
    } catch (err) {
        console.error('Error processing S3 event:', err);
        return { statusCode: 500, body: 'Processing failed' };
    }
};

async function processS3Record(record: S3EventRecord) {
    const bucket = record.s3.bucket.name;
    const encodedKey = record.s3.object.key;
    const key = decodeURIComponent(encodedKey.replace(/\+/g, ' '));
    console.log(`Bucket: ${bucket}`, `Key: ${key}`);

    const pathMatch = key.match(/^originals\/.*\.(xlsx?)$/i);
    if (!pathMatch) {
        console.log(`Skipping file: ${key} - not in valid folder or not Excel file`);
        throw new Error(`Skipping file: ${key} - not in valid folder or not Excel file`);
    }

    const fileName = key.split('/').pop()!;
    const { Body, ContentType, Metadata } = await getQuotationFile(bucket, key);
    const { projectId, userId } = validateMetadata(Metadata);

    if (Metadata?.processed === 'true') {
        console.log('File already processed, skipping');
        throw new Error(`File already processed`);
    }

    await validateUser(userId, projectId);
    return { bucket, key, fileName, Body, ContentType, Metadata, projectId, userId };
}

async function processExcelWorkbook(Body: any, fileName: string, projectId: string, quotationLinks: string[]) {
    const workSheetResult = await parseExcel(Body);
    if (!workSheetResult.success) {
        throw new Error(`Failed to process Excel file: ${workSheetResult.error}`);
    }

    const workbook = workSheetResult.data;
    if (!workbook) {
        throw new Error(`Failed to load workbook from buffer`);
    }

    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
        throw new Error(`Worksheet "${sheetName}" not found`);
    }
    if (worksheet.rowCount === 0) {
        throw new Error(`Worksheet "${sheetName}" is empty`);
    }

    const newQuotationLink = getNewQuotationLink(fileName, projectId);
    if (!quotationLinks.includes(newQuotationLink)) {
        quotationLinks.push(newQuotationLink);
    }

    return { workbook, worksheet };
}

async function executeJobOperations(worksheet: Worksheet, projectId: string, projectDate: ProjectDate, userId: string, quotationLinks: string[]) {
    if (!worksheet) {
        throw new Error(`Worksheet "${sheetName}" not found in workbook`);
    }

    const { headerRowIndex, newKeepColumns, statusColIndex, hasNumberedFormat } = await traceHeaderAndRemovePriceColumn(worksheet);

    const jobs: ExtractedJob[] = hasNumberedFormat
        ? processFileWithJobStartWithNumber(worksheet, headerRowIndex, newKeepColumns)
        : processFileWithJobStartWithOutNumber(worksheet, headerRowIndex, newKeepColumns);

    console.log(`Extracted ${jobs.length} jobs`);

    let operations: Operation[] = [];
    const folderPath = [`${s3Folder.compress}/${projectId}/$1`];
    const { duplicates, existingTitles } = await processJobInsert(jobs, projectId, projectDate, userId, operations);

    operations.push({
        type: 'update',
        table: 'projects',
        data: { quotation_link: quotationLinks, updated_date: new Date().toISOString(), updated_by: userId },
        condition: { id: projectId }
    });

    const transactionResult = await performTransaction(operations);
    if (!transactionResult.success) {
        throw new Error(`Failed to update project: ${transactionResult.error}`);
    }

    console.log(`Successfully processed quotation for project: ${projectId}`);
    const insertedTitles = await getInsertedTitles(transactionResult, folderPath);
    updateResultColumn(jobs, worksheet, duplicates, insertedTitles, existingTitles, statusColIndex);

    return { jobs, newQuotationLink: quotationLinks[quotationLinks.length - 1] };
}

function validateMetadata(Metadata: Record<string, string>) {
    const action = Metadata?.action;
    const projectId = Metadata?.project_id;
    const userId = Metadata?.user_id;

    if (!action || action !== 'quotation') {
        throw new Error(`Invalid action in metadata`);
    }

    if (!projectId || !isValidUUID(projectId)) {
        throw new Error(`Invalid project id in metadata`);
    }

    if (!userId || !isValidCognitoSub(userId)) {
        throw new Error(`Invalid user id in metadata`);
    }

    return { projectId, userId }
}

async function validateUser(userId: string, projectId: string) {
    const userQuery = `
                SELECT u.name as user_name FROM users u 
                JOIN project_assignments pa ON pa.user_id = u.id
                WHERE pa.user_id = $1 AND pa.project_id = $2 AND pa.role = $3
            `;
    const userQueryResult = await executeQuery(userQuery, [userId, projectId, roleEnum['Commercial Officer Admin']]);

    if (!userQueryResult.success) {
        throw new Error(`Failed to fetch user data`);
    }

    if (!userQueryResult.data?.length) {
        throw new Error(`User not found: User ID ${userId}`);
    }

    return userQueryResult.data[0].user_name;
}

async function validateProject(projectId: string) {
    const projectQueryResult = await executeQuery(`SELECT status, quotation_link, plan_start_date, plan_complete_date, 
                actual_complete_date, actual_start_date FROM projects WHERE id = $1`, [projectId]);
    if (!projectQueryResult.success) {
        throw new Error(`Failed to fetch project data`);
    }

    if (!projectQueryResult.data?.length) {
        throw new Error(`Project not found`);
    }

    const projectCurrentStatus = projectQueryResult.data[0].status;
    if (projectCurrentStatus !== projectStatus['Not started'] && projectCurrentStatus !== projectStatus['Started']) {
        throw new Error(`Project status not valid: Project status ${projectStatusName[projectCurrentStatus]}`)
    }

    const projectDate: ProjectDate = {
        plan_start_date: projectQueryResult.data[0].plan_start_date instanceof Date ? projectQueryResult.data[0].plan_start_date : null,
        plan_complete_date: projectQueryResult.data[0].plan_complete_date instanceof Date ? projectQueryResult.data[0].plan_complete_date : null,
        actual_start_date: projectQueryResult.data[0].actual_start_date instanceof Date ? projectQueryResult.data[0].actual_start_date : null,
        actual_complete_date: projectQueryResult.data[0].actual_complete_date instanceof Date ? projectQueryResult.data[0].actual_complete_date : null,
    }

    return { projectDate, quotationLinks: projectQueryResult.data[0]?.quotation_link ?? [] };
}

async function processJobInsert(jobs: ExtractedJob[], projectId: string, projectDate: ProjectDate, userId: string, operations: Operation[]) {
    let duplicates: Set<string> = new Set();
    let existingTitles: Set<string> = new Set();

    if (jobs.length === 0) {
        return { duplicates, existingTitles };
    }

    const jobTitles = jobs.map(job => job.title);
    const uniqueTitles = [...new Set(jobTitles)];
    const seen = new Set();
    duplicates = new Set(jobTitles.filter(title => seen.has(title) ? true : (seen.add(title), false)));

    // Check existing jobs
    const existingJobsResult = await executeQuery(
        'SELECT title FROM jobs WHERE project_id = $1 AND title = ANY($2)',
        [projectId, uniqueTitles]
    );

    existingTitles = new Set(existingJobsResult.success ? existingJobsResult.data.map((row: { title: string; }) => row.title) : []);

    // Prepare batch insert for new jobs (only first occurrence of duplicates)
    const newJobs: ExtractedJob[] = [];
    const seenTitles = new Set();

    jobs.forEach(job => {
        if (!existingTitles.has(job.title) && !seenTitles.has(job.title)) {
            seenTitles.add(job.title);
            newJobs.push(job);
        }
    });
    if (newJobs.length > 0) {
        addNewJobs(newJobs, projectDate, projectId, userId, operations);
    }

    console.log(`Ready created for ${newJobs.length} jobs`);

    return { duplicates, existingTitles };
}

function addNewJobs(newJobs: ExtractedJob[], projectDate: ProjectDate, projectId: string, userId: string, operations: Operation[]) {
    const values = newJobs.map((job, index) => {
        const baseIndex = index * 13;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13})`;
    }).join(', ');

    // Check if all projectDate fields are non-null for transfer
    const hasAllDates = Object.values(projectDate).every(date => date !== null);

    const params = newJobs.flatMap(job => [
        projectId,
        job.title,
        job.description,
        jobStatus['Draft'],
        new Date().toISOString(),
        userId,
        new Date().toISOString(),
        userId,
        jobTypeEnum['Main'],
        hasAllDates ? projectDate.plan_start_date : null,
        hasAllDates ? projectDate.plan_complete_date : null,
        hasAllDates ? projectDate.actual_start_date : null,
        hasAllDates ? projectDate.actual_complete_date : null
    ]);

    const query = `INSERT INTO jobs (project_id, title, description, status, created_date, created_by, updated_date, updated_by, job_type, plan_start_date, plan_complete_date, actual_start_date, actual_complete_date) VALUES ${values} RETURNING id, title`;

    operations.push({
        type: 'query',
        queryText: query,
        params: params
    });
}

async function getInsertedTitles(transactionResult: TransactionResult, folderPath: string[]) {
    const insertedJobs = (transactionResult.results && transactionResult.results.length > 0 && transactionResult.results[0])
        ? transactionResult.results[0]
        : [];
    const insertedTitles = new Set(insertedJobs.map(row => row.title));

    // Create folders for inserted jobs in batches
    if (insertedJobs.length > 0) {
        const jobFolders = insertedJobs.flatMap(job => folderPath.map(path => path.replace('$1', job.id))
        );

        const batchSize = 100;
        for (let i = 0; i < jobFolders.length; i += batchSize) {
            const batch = jobFolders.slice(i, i + batchSize);
            try {
                await invokeFolderCreation(batch);
                console.log(`Created batch ${Math.floor(i / batchSize) + 1}: ${batch.length} folders`);
            } catch (error) {
                console.error(`Failed to create folder batch ${Math.floor(i / batchSize) + 1}:`, error);
            }
        }
        console.log(`Completed folder creation for ${insertedJobs.length} jobs`);
    }

    return insertedTitles;
}

function updateResultColumn(jobs: ExtractedJob[], worksheet: Worksheet, duplicates: Set<string>, insertedTitles: Set<any>, existingTitles: Set<string>, statusColIndex: number) {
    const firstOccurrenceMap = new Map<string, number>();
    jobs.forEach((job, index) => {
        if (!firstOccurrenceMap.has(job.title)) {
            firstOccurrenceMap.set(job.title, index);
        }
    });

    jobs.forEach((job, index) => {
        const row = worksheet.getRow(job.rowIndex);
        let status;

        if (duplicates.has(job.title)) {
            if (firstOccurrenceMap.get(job.title) === index && insertedTitles.has(job.title)) {
                status = JOB_STATUS_MESSAGES.CREATED;
            } else {
                status = JOB_STATUS_MESSAGES.DUPLICATE;
            }
        } else if (existingTitles.has(job.title)) {
            status = JOB_STATUS_MESSAGES.EXISTS;
        } else if (insertedTitles.has(job.title)) {
            status = JOB_STATUS_MESSAGES.CREATED;
        } else {
            status = JOB_STATUS_MESSAGES.FAILED;
        }

        row.getCell(statusColIndex).value = status;
        row.commit();
    });
}

async function saveProcessedFile(workbook: Workbook, bucket: string, newQuotationLink: string, ContentType: string | undefined, Metadata: Record<string, string>, jobs: ExtractedJob[], key: string) {
    try {
        const buffer = await workbook.xlsx.writeBuffer();
        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: newQuotationLink,
            Body: new Uint8Array(buffer),
            ContentType: ContentType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            Metadata: {
                ...Metadata,
                processed: 'true',
                processed_at: new Date().toISOString(),
                jobs_processed: String(jobs.length)
            }
        });

        await s3Client.send(command);
        console.log(`File uploaded successfully with ${jobs.length} jobs processed`);

        const deleteCommand = new DeleteObjectCommand({
            Bucket: bucket,
            Key: key
        });
        await s3Client.send(deleteCommand);
        console.log(`Original file deleted: ${key}`);
    } catch (error: any) {
        console.error('Failed to upload processed file or delete origin:', error);
        throw new Error(`Upload or delete file failed: ${error.message}`);
    }
}

function getNewQuotationLink(fileName: string, projectId: string) {
    const now = new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}_${hours}${minutes}${seconds}`;
    const fileExtension = fileName.split('.').pop();
    const baseFileName = fileName.replace(/\.[^/.]+$/, '');
    const uniqueFileName = `${baseFileName}_${timestamp}.${fileExtension}`;
    const newQuotationLink = `results/${projectId}/${uniqueFileName}`;
    return newQuotationLink;
}

async function getQuotationFile(bucket: string, key: string) {
    let s3Response;
    try {
        s3Response = await s3Client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key
        }));
    } catch (error: any) {
        // Handle specific S3 errors without triggering ListBucket
        if (error.name === 'NoSuchKey') {
            throw new Error(`File not found: ${key}`);
        }
        throw new Error(`Failed to get S3 object: ${error.message}`);
    }

    const { Body, ContentType, Metadata } = s3Response;

    if (!Metadata) {
        throw new Error('File has no metadata');
    }

    if (!Body) {
        throw new Error('File not found or empty.');
    }

    return { Body, ContentType, Metadata };
}

async function parseExcel(stream: any) {
    try {
        const workbook = new Workbook();
        // Read Excel file from stream
        await workbook.xlsx.read(stream);

        return { success: true, data: workbook };
    } catch (error: any) {
        console.error('Error parsing Excel:', error);
        return { success: false, error: error.message };
    }
}

async function traceHeaderAndRemovePriceColumn(worksheet: Worksheet) {
    // Find header row (optimized)
    const headerRowIndex = findHeaderRow(worksheet);
    if (headerRowIndex === -1) throw new Error('Header row not found');

    // Find last column position
    const headerRowObj = worksheet.getRow(headerRowIndex);
    const { uomColIndex, keepColumns } = processHeaderRow(headerRowObj);

    // Remove only columns after last column
    const columnsToRemove = [];
    for (let col = uomColIndex + 1; col <= worksheet.columnCount; col++) {
        columnsToRemove.push(col);
    }

    // Remove from right to left to avoid index shift
    columnsToRemove.reverse().forEach(col => worksheet.spliceColumns(col, 1));

    // Get final column positions
    const newKeepColumns: number[] = [];
    worksheet.getRow(headerRowIndex).eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (headerRow.includes(String(cell.value || '').replace(/\s+/g, ' ').trim())) {
            newKeepColumns.push(colNumber);
        }
    });

    // Add Job Status column after UOM column
    const statusColIndex = uomColIndex + 1;
    worksheet.getRow(headerRowIndex).getCell(statusColIndex).value = 'Job Status';

    // Detect format
    const hasNumberedFormat = detectNumberedFormat(worksheet, headerRowIndex, keepColumns[0]);
    console.log(`Format detected: ${hasNumberedFormat ? 'Numbered' : 'Standard'}`);

    return { headerRowIndex, newKeepColumns, statusColIndex, hasNumberedFormat }
}

function processHeaderRow(headerRowObj: Row) {
    let uomColIndex = -1;
    const keepColumns: number[] = [];

    const lastColumnName = headerRow[headerRow.length - 1];
    headerRowObj.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const cellValue = String(cell.value || '').replace(/\s+/g, ' ').trim();
        if (headerRow.includes(cellValue)) {
            keepColumns.push(colNumber);
            if (cellValue === lastColumnName) {
                uomColIndex = colNumber;
            }
        }
    });

    if (uomColIndex === -1) throw new Error(`${lastColumnName} column not found`);
    return { uomColIndex, keepColumns };
}

function detectNumberedFormat(worksheet: Worksheet, headerRowIndex: number, firstColIndex: number) {
    for (let row = headerRowIndex + 1; row <= worksheet.rowCount; row++) {
        const cell = worksheet.getRow(row).getCell(firstColIndex);
        if (cell && cell.value && String(cell.value).trim() !== '') {
            const cellValue = String(cell.value).replace(/'/g, '').trim();
            if (/^\d+(\.\d+)?\.$/.test(cellValue)) {
                return true;
            }
        }
    }
    return false;
}

function processFileWithJobStartWithNumber(worksheet: Worksheet, headerRowIndex: number, keepColumns: number[]) {
    const jobs: ExtractedJob[] = [];
    const [itemNoColIndex, descColIndex] = keepColumns;
    let isSearchDescription = false;
    let currentJobTitle = '';
    let descriptionText: string[] = [];
    let jobStartRow = null;

    for (let row = headerRowIndex + 1; row <= worksheet.rowCount; row++) {
        const itemNoCell = worksheet.getRow(row).getCell(itemNoColIndex);
        const descCell = worksheet.getRow(row).getCell(descColIndex);
        const itemValue = itemNoCell?.text ? itemNoCell.text.replace(/'/g, '').trim() : '';
        const descValue = descCell?.text ? descCell.text.trim() : '';

        if (itemValue) {
            // Save previous job's description if any
            ({ isSearchDescription, descriptionText } = updateDescription(isSearchDescription, descriptionText, jobs, currentJobTitle, jobStartRow ?? row - 1));
            // Start new job
            if (descValue) {
                isSearchDescription = true;
                currentJobTitle = descValue;
                descriptionText = [];
                jobStartRow = row;
            } else {
                isSearchDescription = false;
                currentJobTitle = '';
                descriptionText = [];
                jobStartRow = null;
            }
        } else {
            if (descValue) {
                if (isSearchDescription) {
                    descriptionText.push(descValue);
                }
            } else {
                // Empty row -> end search Description
                ({ isSearchDescription, descriptionText } = updateDescription(isSearchDescription, descriptionText, jobs, currentJobTitle, jobStartRow ?? row - 1));
                jobStartRow = null;
            }
        }
    }
    // Save last job's description if any
    ({ isSearchDescription, descriptionText } = updateDescription(isSearchDescription, descriptionText, jobs, currentJobTitle, jobStartRow ?? worksheet.rowCount));
    return jobs;
}

function updateDescription(isSearchDescription: boolean, descriptionText: string[], jobs: ExtractedJob[], currentJobTitle: string, row: number) {
    if (isSearchDescription) {
        // Save job only if there is a title
        if (currentJobTitle) {
            const combinedText = descriptionText.length > 0 ? descriptionText.join('\n') : currentJobTitle;
            jobs.push({ title: currentJobTitle, description: combinedText, rowIndex: row });
        }
        descriptionText = [];
        isSearchDescription = false;
    }
    return { isSearchDescription, descriptionText };
}

function processFileWithJobStartWithOutNumber(worksheet: Worksheet, headerRowIndex: number, keepColumns: number[]) {
    const jobs = [];
    const [itemNoColIndex, descColIndex] = keepColumns;
    let isNote = false;

    for (let row = headerRowIndex + 1; row <= worksheet.rowCount; row++) {
        const itemNoCell = worksheet.getRow(row).getCell(itemNoColIndex);
        const descCell = worksheet.getRow(row).getCell(descColIndex);
        const itemValue = itemNoCell?.text ? itemNoCell.text.trim() : '';
        const description = descCell?.text ? descCell.text.trim() : '';

        if (itemValue) continue;

        // Improved note detection: allow "note:", "notes:", case-insensitive, and ignore leading spaces
        if (/^\s*notes?:/i.test(description)) {
            console.log(`Note detected at row ${row}`);
            isNote = true;
            continue;
        }

        if (isNote) {
            // End note mode when reach empty row
            if (!description) {
                console.log(`Note mode ended at row ${row}`);
                isNote = false;
            } else {
                console.log(`Skipping note content at row ${row}`);
            }
            continue;
        }

        if (description) {
            jobs.push({ title: description, description, rowIndex: row });
        }
    }
    return jobs;
}

// Optimized header row finder
function findHeaderRow(worksheet: Worksheet) {
    for (let row = 1; row <= Math.min(10, worksheet.rowCount); row++) {
        const rowObj = worksheet.getRow(row);
        const rowData: string[] = [];

        rowObj.eachCell({ includeEmpty: true }, (cell) => {
            rowData.push(String(cell.value || '').replace(/\s+/g, ' ').trim());
        });

        if (headerRow.every(header => rowData.includes(header))) {
            return row;
        }
    }

    return -1;
}

async function invokeFolderCreation(createProjectFolders: string[]) {
  const bucketName = process.env.DESTINATION_BUCKET;

  if (!bucketName) {
    console.error('DESTINATION_BUCKET environment variable not set');
    throw new Error('Missing required environment variable');
  }

  console.log('Invoking folder creation Lambda');
  console.log('Folder count:', createProjectFolders.length);

  try {
    const results = await Promise.allSettled(
      createProjectFolders.map(folder =>
        s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: folder,
          Body: '',
          ContentLength: 0
        }))
      )
    );

    // Log results
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    console.log(`Created ${successful} folders successfully, ${failed} failed`);

    if (failed > 0) {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Failed to create ${createProjectFolders[index]}:`, result.reason.message);
        }
      });
    }

    console.log('Lambda invocation completed successfully');
  } catch (error: any) {
    console.error('Failed to invoke folder creation Lambda:', error.name || 'Unknown error');
    throw new Error('Folder creation failed');
  }
}