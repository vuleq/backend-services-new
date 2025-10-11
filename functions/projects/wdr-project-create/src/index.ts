import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { executeQuery, performTransaction, Operation, DynamicValue } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo, ValidationSchema, validateSchema } from 'wdr-common-utils';
import { getWBS, GetWBSRequest, WBSGetDataResult } from 'wdr-connect-external';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ region: process.env.AWS_REGION });

const projectStatus = {
  'Not Started': 0,
  Started: 1,
  Completed: 2,
  Closed: 3
};

const roleCodeEnum = {
  'Super User': 'SU',
  'Ship Repair Manager': 'SRM',
  'Safety Officer': 'SO',
  'Commercial Officer Admin': 'COA',
  'Commercial Officer': 'CO'
};

const roleEnum = {
  'SU': 0,
  'SRM': 1,
  'SO': 2,
  'COA': 3,
  'CO': 4
};

interface ProjectCreateInputModel {
  mainCode: string;
  vesselName: string;
  createdDate: string;
  updatedDate: string;
  srm?: string[]; // Array of user IDs for SRM role
}

interface ProjectCreateDataModel {
  main_code: string;
  vessel_name: string;
  created_date: string;
  updated_date: string;
  created_by: string;
  updated_by: string;
  status: number;
}

interface AssignUserModel {
  role: string;
  user_id: string;
  project_id?: DynamicValue | string;
}

interface InvalidProjectModel { index: number, errors: string[] }
interface ValidProjectModel {
  index: number;
  data: {
    projectData: ProjectCreateDataModel;
    assignments: AssignUserModel[];
  }
}

interface UserDataModel {
  id: string;
  name: string;
  email: string;
  roles: string[]; // 'SRM', 'SU' or 'COA'
}

interface SubCodeCreateModel {
  sub_no: string;
  wbs_element: string;
  description: string;
  project_id: string | DynamicValue;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface InsertProjectResultModel {
  id: string;
  main_code: string;
  vessel_name: string;
  created_date: Date;
  updated_date: Date;
  owner_rep: null;
  ship_contact: null;
  vscc_meeting_time: null;
  arrival_date: null;
  departure_date: null;
  docking_date: null;
  undocking_date: null;
  plan_start_date: null;
  plan_complete_date: null;
  actual_start_date: null;
  actual_complete_date: null;
  remark: null;
  status: number;
  updated_by: string;
  quotation_link: null;
  vessel_size: null;
  feedback: null;
  created_by: string;
}

// Define validation schema
const projectCreateValidateSchema: ValidationSchema = {
  main_code: { required: true, type: 'string', message: 'Main code must be a valid string' },
  vessel_name: { required: true, type: 'string', message: 'Vessel name must a valid string' },
  created_date: { required: true, type: 'date', message: 'Created date must be a valid date' },
  updated_date: { required: true, type: 'date', message: 'Updated date must be a valid date' }
};

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  try {
    // Parse input and extract user information
    const requestHeader = event.headers;
    const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

    if (!loginUserId || !isValidCognitoSub(loginUserId)) {
      return new LambdaResponse(400, new ApiResponse(false, null, 'User not logined'));
    }

    // Get all Super User and COA to assign
    const superUserAndCOADatas = await getUserData([roleCodeEnum['Super User'], roleCodeEnum['Commercial Officer Admin']]);
    // Only COA can import project
    if (superUserAndCOADatas.length === 0 || !superUserAndCOADatas.find(e => e.id === loginUserId && e.roles.includes(roleCodeEnum['Commercial Officer Admin']))) {
      return new LambdaResponse(403, new ApiResponse(false, null, 'User is not allowed to import project'));
    }

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    const projects: ProjectCreateInputModel[] = Array.isArray(body) ? body : [body];

    const allProjectCodes = [...new Set(projects.map(p => p.mainCode).filter(code => code))];
    const srmUserIds = [...new Set(projects.flatMap(obj => obj.srm || []).filter(id => typeof id === 'string' && isValidUUID(id)))];

    const existingCodes = await getExistedMainCode(allProjectCodes);
    const srmUserDatas = await getUserData([roleCodeEnum['Ship Repair Manager']], srmUserIds);

    console.log(`Start validate project data`);
    const { validProjects, invalidProjects } = validateProjectData(projects, existingCodes, loginUserId, srmUserDatas);

    const { insertedProjects, createProjectFolders } = await createProjects(validProjects, superUserAndCOADatas, invalidProjects, srmUserDatas);

    const response = {
      success: insertedProjects.length,
      error: invalidProjects.length
    };

    // Invoke folder creation asynchronously with batching
    if (createProjectFolders.length > 0) {
      // Batch folders in groups of 10 to avoid payload size limits
      const batchSize = 10;
      for (let i = 0; i < createProjectFolders.length; i += batchSize) {
        const batch = createProjectFolders.slice(i, i + batchSize);
        await invokeFolderCreation(batch);
      }
    }

    if (insertedProjects.length > 0) {
      await executeQuery(`UPDATE project_temp SET new_project_count = new_project_count - $1`, [insertedProjects.length]);
    }

    return new LambdaResponse(200, new ApiResponse(true, response));
  } catch (err: any) {
    console.error('Error in add-project:', err);
    return new LambdaResponse(400, new ApiResponse(false, null, 'Project import failed: ' + err.message || 'An unexpected error occurred'));
  }
};

async function createProjects(validProjects: ValidProjectModel[], superUserAndCOADatas: UserDataModel[], invalidProjects: InvalidProjectModel[], srmUserDatas: UserDataModel[]) {
  console.log(`Start insert project data`);
  let insertedProjects: InsertProjectResultModel[] = [];
  let createProjectFolders: string[] = [];

  if (validProjects.length > 0) {
    for (const project of validProjects) {
      try {
        const { projectData, assignments } = project.data;

        const operations: Operation[] = [
          {
            type: 'insert',
            table: 'projects',
            data: projectData,
            returningClause: '*'
          }
        ];

        // Assign all Super Users and COA in system
        for (const user of superUserAndCOADatas) {
          user.roles.forEach(roleCode => {
            operations.push({
              type: 'insert',
              table: 'project_assignments',
              data: {
                project_id: {
                  type: 'dynamic_result',
                  fromIndex: 0,
                  field: 'id'
                },
                role: roleEnum[roleCode as keyof typeof roleEnum],
                role_code: roleCode,
                user_id: user.id,
              }
            });
          });
        }

        // Add assignment operations - SRM role only
        for (const assignment of assignments) {
          operations.push({
            type: 'insert',
            table: 'project_assignments',
            data: {
              project_id: {
                type: 'dynamic_result',
                fromIndex: 0,
                field: 'id'
              },
              role: roleEnum['SRM'],
              role_code: assignment.role,
              user_id: assignment.user_id,
            }
          });
        }

        // Call SAP to get WBS data
        // No notify for user for now
        const wbsError = await getWBSFromSAP(operations, projectData);

        const txResult = await performTransaction(operations);
        if (!txResult.success) {
          invalidProjects.push({
            index: project.index,
            errors: ['Failed to insert project data']
          });
          continue;
        }

        const insertedProject: InsertProjectResultModel = txResult.results?.[0][0];
        insertedProjects.push(insertedProject);
        console.log(`Project inserted: ${insertedProject.main_code} (${insertedProject.id})`);

        createProjectFolders.push(`compress/${insertedProject.id}/`);
        createProjectFolders.push(`results/${insertedProject.id}/`);
      } catch (dbError: any) {
        console.error('Database operation error:', dbError);
        invalidProjects.push({
          index: project.index,
          errors: ['Failed to insert project data']
        });
      }
    }
  }

  return { insertedProjects, createProjectFolders };
}

async function getWBSFromSAP(operations: Operation[], projectData: ProjectCreateDataModel) {
  const now = new Date();

  try {
    const wbsRequest: GetWBSRequest = {
      project_code: projectData.main_code
    };

    const wbsResultData: WBSGetDataResult = await getWBS(wbsRequest);

    if (!wbsResultData.success) {
      return wbsResultData.error;
    }

    const wbsResult = wbsResultData.data || [];

    console.log('WBS count:', wbsResult.length);
    wbsResult.forEach(data => {
      if (data.wbs_element) {
        const createWBSData: SubCodeCreateModel = {
          sub_no: data.wbs_element.split('.').reverse()[0],
          wbs_element: data.wbs_element,
          description: data.wbs_element_desc,
          project_id: {
            type: 'dynamic_result',
            fromIndex: 0,
            field: 'id'
          },
          created_by: projectData.created_by,
          updated_by: projectData.updated_by,
          created_at: now,
          updated_at: now
        }
        operations.push({
          type: 'insert',
          table: 'sub_codes',
          data: createWBSData
        });
      }
    });
  } catch (wbsErr) {
    console.error(`Exception in WBS fetch for project ${projectData.main_code}:`, wbsErr);
    return `Exception in WBS fetch for project ${projectData.main_code}:`;
  }
}

function processProject(project: ProjectCreateInputModel, existingCodes: string[], createdUserId: string, srmUserDatas: UserDataModel[]) {
  const errors: string[] = [];
  const projectData: ProjectCreateDataModel = {
    main_code: project.mainCode,
    vessel_name: project.vesselName,
    created_date: project.createdDate,
    updated_date: project.updatedDate,
    created_by: createdUserId,
    updated_by: createdUserId,
    status: projectStatus['Not Started']
  };
  const assignments: AssignUserModel[] = [];

  if (project.srm) {
    for (const userId of project.srm) {
      if (srmUserDatas.find(e => e.id === userId)) {
        assignments.push({
          role: roleCodeEnum['Ship Repair Manager'],
          user_id: userId
        });
      } else {
        errors.push(`Invalid srm id: ${userId}`);
      }
    }
  }

  const validation = validateSchema(projectData, projectCreateValidateSchema);
  if (!validation.isValid) {
    errors.push(...validation.errors.map(e => `${e.field}: ${e.message}`));
  }

  if (existingCodes.includes(projectData.main_code)) {
    errors.push(`Project with main code "${projectData.main_code}" already exists`);
  }

  // Validate date relationship
  const createdDate = new Date(projectData.created_date);
  const updatedDate = new Date(projectData.updated_date);

  if (updatedDate < createdDate) {
    errors.push('Updated date cannot be earlier than created date');
  }

  return { isValid: errors.length === 0, errors, data: { projectData, assignments } };
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
        s3.send(new PutObjectCommand({
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

async function getExistedMainCode(allProjectCodes: string[]): Promise<string[]> {
  if (allProjectCodes.length === 0) {
    return [];
  }

  const selectProjectQuery = `SELECT main_code FROM projects WHERE main_code = ANY($1)`;
  const selectProjectResult = await executeQuery(selectProjectQuery, [allProjectCodes]);
  if (!selectProjectResult.success) {
    throw new Error('Failed to validate project codes');
  }

  return selectProjectResult.data.map((p: { main_code: string }) => p.main_code);
}

function validateProjectData(projects: ProjectCreateInputModel[], existingCodes: string[], loginUserId: string, srmUserDatas: UserDataModel[]) {
  const invalidProjects: InvalidProjectModel[] = [];
  const validProjects: ValidProjectModel[] = [];

  // Process and transform projects (basic validation handled by API Gateway)
  for (let index = 0; index < projects.length; index++) {
    const project = projects[index];
    const { isValid, errors, data } = processProject(project, existingCodes, loginUserId, srmUserDatas);

    if (!isValid) {
      invalidProjects.push({ index, errors });
    } else {
      validProjects.push({ index, data });
      existingCodes.push(data.projectData.main_code);
    }
  }
  return { validProjects, invalidProjects };
}

async function getUserData(roleCodes: string[], userIds?: string[]): Promise<UserDataModel[]> {
  const baseQuery = `SELECT u.id, u.name, u.email, array_agg(r.code) as roles
    FROM users u 
    JOIN user_roles ur ON ur.user_id = u.id 
    JOIN roles r ON r.id = ur.role_id`;

  let whereClause = `WHERE r.code = ANY($1)`;
  const params: any[] = [roleCodes];

  if (userIds && userIds.length > 0) {
    whereClause += ` AND u.id = ANY($2)`;
    params.push(userIds);
  }

  const groupByClause = `GROUP BY u.id, u.name, u.email`;

  const result = await executeQuery(`${baseQuery} ${whereClause} ${groupByClause}`, params);
  if (!result.success) {
    throw new Error('Failed to get user data');
  }

  return result.data;
}