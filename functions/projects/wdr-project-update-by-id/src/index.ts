import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError, ValidationError, DataBaseError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo, validateRequiredFields, isValidTime } from 'wdr-common-utils';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

enum ProjectStatus {
    'Not started' = 0,
    Started,
    Completed,
    Closed,
}

enum JobStatusEnum {
    Draft = 0,
    Confirmed,
    Cancelled,
    Started,
    Completed
}

enum WdrStatusEnum {
    'Not started' = 0,
    Draft,
    'Pre review',
    'HOD review',
    'SRM review',
    Completed
}

enum RoleEnum {
    'Super User' = 0,
    'SRM',
    'Safety Officer',
    'Commercial Officer Admin',
    'Commercial Officer',
    'Guest'
};

interface IProjectUpdateDataModel {
    vessel_name: string;
    vessel_size: {
        width: number;
        height: number;
        length: number
    },
    plan_start_date: string;
    plan_complete_date: string;
    actual_start_date: string;
    actual_complete_date: string;
    arrival_date: string;
    departure_date: string;
    docking_date: string;
    undocking_date: string;
    vscc_meeting_time?: string | null;
    ship_contact?: string | null;
    owner_rep: string;
    remark?: string | null;
    updated_date: string;
    updated_by: string;
    status: number;
}

interface IProjectFromDB {
    vessel_name: string;
    vessel_size: {
        width: number;
        height: number;
        length: number
    },
    plan_start_date: Date;
    plan_complete_date: Date;
    actual_start_date: Date;
    actual_complete_date: Date;
    arrival_date: Date;
    departure_date: Date;
    docking_date: Date;
    undocking_date: Date;
    vscc_meeting_time?: string | null;
    ship_contact?: string | null;
    owner_rep: string;
    remark?: string | null;
    updated_date: Date;
    updated_by: string;
    status: number;
}

// Define which fields are required
const requiredFields: (keyof IProjectUpdateDataModel)[] = [
    'vessel_name', 'plan_start_date', 'plan_complete_date', 'actual_start_date', 'actual_complete_date',
    'arrival_date', 'departure_date', 'docking_date', 'undocking_date', 'owner_rep', 'status'
];

interface IJobShiftData {
    id?: string;
    actual_start_date: Date;
    actual_complete_date: Date;
}

interface IFieldValue {
    field: string;
    value: any;
}

interface IHistoryLog {
    old_value: IFieldValue[];
    new_value: IFieldValue[];
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('Event: ', JSON.stringify(event, null, 2));

    try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
        const projectId = event.pathParameters?.id;

        if (!projectId) {
            return new LambdaResponse(400, buildError('MISSING_REQUIRED_FIELD', 'Project ID is required'));
        }

        if (!isValidUUID(projectId)) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid project ID format'));
        }

        // Get user information from Cognito claims
        const requestHeader = event.headers;
        const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

        if (!loginUserId || !isValidCognitoSub(loginUserId)) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid user ID format'));
        }

        const roles = await isUserAllowToUpdateProject(loginUserId, projectId);

        const newStatus = typeof body.status === 'string' ? ProjectStatus[body.status as keyof typeof ProjectStatus] : undefined;

        if (newStatus === undefined) {
            throw new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid status'));
        }

        const projectData: IProjectUpdateDataModel = {
            vessel_name: body.vesselName,
            owner_rep: body.ownerRep,
            ship_contact: body.shipContact,
            vscc_meeting_time: body.vsccMeetingTime || null,
            vessel_size: {
                height: body.vesselSize?.height,
                width: body.vesselSize?.width,
                length: body.vesselSize?.length
            },
            arrival_date: body.arrivalDate,
            departure_date: body.departureDate,
            docking_date: body.dockingDate,
            undocking_date: body.undockingDate,
            plan_start_date: body.planStartDate,
            plan_complete_date: body.planCompleteDate,
            actual_start_date: body.actualStartDate,
            actual_complete_date: body.actualCompleteDate,
            remark: body.remark,
            updated_date: new Date().toISOString(),
            updated_by: loginUserId,
            status: newStatus,
        };

        // Process project data
        validateProjectData(projectData);

        // Get current project data
        const currentProject = await getProjectById(projectId);

        if (currentProject.status === ProjectStatus['Closed']) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Cannot update a closed project'));
        }

        if (currentProject.status && projectData.status && currentProject.status != projectData.status) {
            await validateProjectStatus(currentProject.status, projectData.status, roles, projectId);
        }

        const operations: Operation[] = [{
            type: 'update',
            table: 'projects',
            data: projectData,
            condition: { id: projectId },
            returningClause: '*'
        }];

        // History feature
        const historyUpdateProjectFields: IHistoryLog = {
            new_value: [],
            old_value: []
        };

        const shiftedDate = compareProject(currentProject, projectData, historyUpdateProjectFields);

        const shiftDateOperation: Operation[] = [];
        if (shiftedDate !== 0 && currentProject.status === ProjectStatus['Not started']) {
            await shiftDateForJob(shiftedDate, projectId, shiftDateOperation);
        }

        console.log('historyUpdateProjectFields: ', JSON.stringify(historyUpdateProjectFields));

        if (historyUpdateProjectFields.new_value.length > 0) {
            if (roles.length === 1 && roles[0] === RoleEnum['Commercial Officer Admin']) {
                return new LambdaResponse(400, buildError('ACCESS_DENIED', 'User does not has permission to update project!'));
            }
            // History feature implement late
            // add history to operations
        }

        await shiftDateForNotSetDateJobs(projectId, projectData, shiftDateOperation);

        // Perform all updates in a transaction
        const transactionResult = await performTransaction(operations);

        if (!transactionResult.success) {
            console.error('Transaction failed:', transactionResult.error);
            return new LambdaResponse(400, buildError('DATABASE_ERROR', transactionResult.error || 'Failed to update project'));
        }

        // Get updated project data from first operation result
        const updatedProject = transactionResult.results?.[0] ? transactionResult.results[0][0] : null;

        // Shift date not effected update project
        if (shiftDateOperation.length > 0) {
            const shiftResult = await performTransaction(shiftDateOperation);
            if (!shiftResult.success) {
                console.error('Shift date transaction failed:', shiftResult.error);
            }
        }

        return new LambdaResponse(200, new ApiResponse(true, updatedProject, 'Project updated successfully'));
    } catch (err: any) {
        console.error('Error in update-project:', err);
        if (err instanceof ValidationError) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', err.message));
        }
        if (err instanceof DataBaseError) {
            return new LambdaResponse(400, buildError('DATABASE_ERROR', err.message));
        }
        return new LambdaResponse(400, buildError('LAMBDA_SERVICE_EXCEPTION', 'An error occurred while updating the project'));
    }
};

async function shiftDateForNotSetDateJobs(projectId: string, projectData: IProjectUpdateDataModel, operations: Operation[]) {
    const searchJobsResult = await executeQuery(`SELECT id FROM jobs WHERE project_id = $1 AND 
        actual_start_date IS NULL AND actual_complete_date IS NULL AND plan_start_date IS NULL AND plan_complete_date IS NULL`,
        [projectId]);

    if (!searchJobsResult.success) {
        console.log('Failed to fetch jobs data');
        throw new DataBaseError(`Failed to fetch jobs data`);
    }

    if (searchJobsResult.rowCount === 0) {
        return;
    }

    const jobIds: string[] = searchJobsResult.data.map((row: { id: string }) => row.id);

    const jobData = {
        plan_start_date: projectData.plan_start_date,
        plan_complete_date: projectData.plan_complete_date,
        actual_start_date: projectData.actual_start_date,
        actual_complete_date: projectData.actual_complete_date,
    };

    // Use map to create all operations at once, then spread into operations array
    const jobOperations: Operation[] = jobIds.map(jobId => ({
        type: 'update',
        table: 'jobs',
        data: jobData,
        condition: { id: jobId },
        returningClause: ''
    }));

    operations.push(...jobOperations);
}

async function validateProjectStatus(currentStatus: number, newStatus: number, roles: number[], projectId: string) {
    const validNextStatus = getNextStatus(currentStatus);
    if (!validNextStatus.includes(newStatus)) {
        throw new ValidationError(`Invalid status transition from ${ProjectStatus[currentStatus]} to ${ProjectStatus[newStatus]}`);
    }

    const isCOACanChangeStatus = newStatus === ProjectStatus.Closed;
    const validProjectRoles = [isCOACanChangeStatus ? RoleEnum['Commercial Officer Admin'] : RoleEnum.SRM, RoleEnum['Super User']];
    const hasPermission = roles.some(role => validProjectRoles.includes(role));

    if (!hasPermission) {
        if (isCOACanChangeStatus) {
            throw new ValidationError('User does not have permission to change project status: Must be Commercial Officer Admin or Super User');
        } else {
            throw new ValidationError('User does not have permission to change project status: Must be SRM or Super User');
        }
    }

    if (newStatus === ProjectStatus.Completed) {
        // Much has no remain job and all WDR complete
        const jobCheckResult = await executeQuery(`SELECT COUNT(*) as count FROM jobs WHERE project_id = $1 
            AND (status != $2 OR wdr_status != $3)`, [projectId, JobStatusEnum.Completed, WdrStatusEnum.Completed]);

        if (!jobCheckResult.success) {
            throw new DataBaseError(`Failed to fetch jobs data`);
        }

        if (jobCheckResult.data[0].count > 0) {
            throw new ValidationError('Project status cannot be updated to Completed. Pending jobs or incomplete WDRs must be finished first.');
        }
    }
}

function getNextStatus(currentStatus: number) {
    if (currentStatus === null || currentStatus === undefined) {
        throw new ValidationError('Current status is required');
    }
    switch (currentStatus) {
        case ProjectStatus['Not started']:
            return [ProjectStatus.Started];
        case ProjectStatus.Started:
            return [ProjectStatus.Completed];
        case ProjectStatus.Completed:
            return [ProjectStatus.Closed];
        default:
            throw new ValidationError(`Invalid current status: ${currentStatus}`);
    }
}

function validateProjectData(projectData: IProjectUpdateDataModel) {
    // Validate the data
    const validation = validateRequiredFields<IProjectUpdateDataModel>(projectData, requiredFields);

    if (!validation.isValid) {
        throw new ValidationError(`Missing required fields: ${validation.missingFields.join(', ')}`);
    }

    if (!projectData.vessel_size || typeof projectData.vessel_size !== 'object') {
        throw new ValidationError('Vessel size is required and must be an object');
    }

    if (!projectData.vessel_size?.width || !projectData.vessel_size?.height || !projectData.vessel_size?.length ||
        typeof projectData.vessel_size.width !== 'number' || typeof projectData.vessel_size.height !== 'number' || typeof projectData.vessel_size.length !== 'number') {
        throw new ValidationError('Vessel size dimensions must be numbers');
    }

    if (projectData.vessel_size.width <= 0 || projectData.vessel_size.height <= 0 || projectData.vessel_size.length <= 0) {
        throw new ValidationError('Vessel size dimensions must be greater than zero');
    }

    // Validate date
    if (!isDateRangeValid(projectData.arrival_date, projectData.departure_date)) {
        throw new ValidationError('Departure date must be after arrival date');
    }

    if (!isDateRangeValid(projectData.docking_date, projectData.undocking_date)) {
        throw new ValidationError('Undocking Date must be after docking date');
    }

    if (!isDateRangeValid(projectData.arrival_date, projectData.docking_date)) {
        throw new ValidationError('Docking Date must be after arrival date');
    }

    if (!isDateRangeValid(projectData.undocking_date, projectData.departure_date)) {
        throw new ValidationError('Departure date must be after undocking date');
    }

    if (!isDateRangeValid(projectData.plan_start_date, projectData.plan_complete_date)) {
        throw new ValidationError('Plan Complete Date must be after plan start date');
    }

    if (!isDateRangeValid(projectData.actual_start_date, projectData.actual_complete_date)) {
        throw new ValidationError('Actual Complete Date must be after actual start date');
    }

    if (projectData.vscc_meeting_time && !isValidTime(projectData.vscc_meeting_time)) {
        throw new ValidationError('VSCC Meeting Time is not valid');
    }
}

function isDateRangeValid(startDate: string | Date, endDate: string | Date) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return false;
    }
    return start <= end;
}

async function isUserAllowToUpdateProject(userId: string, projectId: string) {
    let userRoles: number[] = [];

    console.log(`UserId: ${userId}, ProjectId: ${projectId}`);
    const query = `
        SELECT pa.role, p.vessel_name as project_name
        FROM projects p
        LEFT JOIN project_assignments pa 
            ON p.id = pa.project_id 
            AND pa.user_id = $1 
            AND pa.role = ANY($3)
        WHERE p.id = $2
    `;
    const result = await executeQuery(query, [userId, projectId, [RoleEnum.SRM, RoleEnum['Super User'], RoleEnum['Commercial Officer Admin']]]);

    if (!result.success) {
        throw new DataBaseError('Failed to fetch user roles');
    }
    const projectName = (result.data && result.data.length > 0) ? result.data[0].project_name : null;
    if (!result.rowCount || !result.data.some((row: any) => row.role !== null)) {
        console.log('getUserRoles: No roles SRM or Super User or Commercial Officer Admin found for user');
        throw new ValidationError(`User does not has permission to update project ${projectName}`);
    } else {
        userRoles = result.data
            .filter((row: { role: number | null }) => row.role !== null)
            .map((row: { role: number }) => row.role);
    }

    return userRoles;
}

async function getProjectById(projectId: string): Promise<IProjectFromDB> {
    const projectResult = await executeQuery(`SELECT vessel_name, vessel_size, plan_start_date, plan_complete_date, actual_start_date, 
        actual_complete_date, arrival_date, departure_date, docking_date, undocking_date, vscc_meeting_time, ship_contact, owner_rep,
        remark, status FROM projects WHERE id = $1`, [projectId]);

    if (!projectResult.success) {
        console.error('Failed to fetch project:', projectResult.error?.message || 'Unknown error');
        throw new DataBaseError('Failed to fetch project');
    }

    if (!projectResult.data || projectResult.data.length === 0) {
        throw new ValidationError('Project not found');
    }

    const project = projectResult.data[0];

    return {
        vessel_name: project.vessel_name,
        vessel_size: project.vessel_size,
        plan_start_date: project.plan_start_date,
        plan_complete_date: project.plan_complete_date,
        actual_start_date: project.actual_start_date,
        actual_complete_date: project.actual_complete_date,
        arrival_date: project.arrival_date,
        departure_date: project.departure_date,
        docking_date: project.docking_date,
        undocking_date: project.undocking_date,
        vscc_meeting_time: project.vscc_meeting_time,
        ship_contact: project.ship_contact,
        owner_rep: project.owner_rep,
        remark: project.remark,
        updated_date: project.updated_date,
        updated_by: project.updated_by,
        status: project.status
    };
}

function compareProject(currentProject: IProjectFromDB, projectData: IProjectUpdateDataModel, history: IHistoryLog) {
    let shiftedDate = 0;
    const simpleFields: (keyof IProjectUpdateDataModel)[] = [
        'vessel_name', 'owner_rep', 'ship_contact', 'remark'
    ];

    const dateFields: (keyof IProjectUpdateDataModel)[] = [
        'arrival_date', 'departure_date', 'docking_date', 'undocking_date',
        'plan_start_date', 'plan_complete_date', 'actual_start_date', 'actual_complete_date'
    ];

    const timeFields: (keyof IProjectUpdateDataModel)[] = [
        'vscc_meeting_time'
    ];

    for (const field of simpleFields) {
        if (currentProject[field] !== projectData[field]) {
            history.old_value.push({ field, value: currentProject[field] });
            history.new_value.push({ field, value: projectData[field] });
        }
    }

    for (const field of dateFields) {
        const currentValue = currentProject[field];
        const newValue = projectData[field];
        const oldDate = currentValue ? (currentValue as Date).toISOString().split('T')[0] : null;
        const newDate = newValue && typeof newValue === 'string' ? newValue.split('T')[0] : null;
        if (oldDate !== newDate) {
            history.old_value.push({ field, value: currentValue });
            history.new_value.push({ field, value: newValue });

            if (field === 'actual_start_date' && oldDate && newDate) {
                shiftedDate = Math.floor((new Date(newDate).getTime() - new Date(oldDate).getTime()) / (1000 * 60 * 60 * 24));
            }
        }
    }

    for (const field of timeFields) {
        const currentValue = currentProject[field];
        const newValue = projectData[field];
        if (currentValue !== newValue) {
            history.old_value.push({ field, value: currentValue });
            history.new_value.push({ field, value: newValue });
        }
    }

    // Handle vessel_size object comparison
    const oldSize = currentProject.vessel_size;
    const newSize = projectData.vessel_size;
    if (oldSize?.width !== newSize?.width || oldSize?.height !== newSize?.height || oldSize?.length !== newSize?.length) {
        history.old_value.push({ field: 'vessel_size', value: oldSize });
        history.new_value.push({ field: 'vessel_size', value: newSize });
    }

    return shiftedDate;
}

async function shiftDateForJob(shiftedDate: number, projectId: string, operations: Operation[]) {
    const allJobsResult = await executeQuery(`SELECT id, actual_start_date, actual_complete_date FROM jobs 
        WHERE project_id = $1 AND actual_start_date IS NOT NULL AND actual_complete_date IS NOT NULL 
        AND status = $2`, [projectId, JobStatusEnum['Draft']]);
    if (!allJobsResult.success) {
        throw new DataBaseError(`Error retrieving jobs`);
    }

    const allJobs: IJobShiftData[] = allJobsResult.data;
    if (allJobs.length === 0) {
        console.log('No jobs found for project, skipping date shift');
        return;
    }

    for (const job of allJobs) {
        const newActualStartDate = new Date(job.actual_start_date);
        const newActualCompleteDate = new Date(job.actual_complete_date);
        newActualStartDate.setDate(newActualStartDate.getDate() + shiftedDate);
        newActualCompleteDate.setDate(newActualCompleteDate.getDate() + shiftedDate);

        const updateJobData: IJobShiftData = {
            actual_start_date: newActualStartDate,
            actual_complete_date: newActualCompleteDate,
        };

        operations.push({
            type: 'update',
            table: 'jobs',
            data: updateJobData,
            condition: { id: job.id },
            returningClause: ''
        });
    }
}

