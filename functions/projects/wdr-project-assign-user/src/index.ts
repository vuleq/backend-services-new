import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError, ValidationError, DataBaseError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

enum ProjectStatus {
    'Not started' = 0,
    Started,
    Completed,
    Closed
};

enum RoleEnum {
    'Super User' = 0, // Not allow update
    'SRM',
    'Safety Officer',
    'Commercial Officer Admin',
    'Commercial Officer'
};

enum RoleCodeEnum {
    'Super User' = 'SU', // Not allow update
    'SRM' = 'SRM',
    'Safety Officer' = 'SO',
    'Commercial Officer Admin' = 'COA',
    'Commercial Officer' = 'CO'
};

enum TradeMemberRoleCode {
    'Head of Department' = 'HOD',
    'Foreman' = 'FOR',
    'Supervisor' = 'TS',
};

interface IUserAssignRole {
    id: string;
    user_id: string;
    name: string;
    email: string;
    role: number; // This should match the roleEnum keys or tradeMemberRoleCode.
}

interface IAssignProjectRolesDataModel {
    assignUsers: IAssignUserModel[],
    unAssignUsers: string[]
}

interface IAssignUserModel {
    userId: string;
    role: string; // This should match the roleEnum keys or tradeMemberRoleCode.
}

interface IAssignProjectRolesInsertDataModel {
    user_id: string;
    role: number;
    role_code: string; // This should match the RoleCodeEnum keys.
    project_id: string;
}

interface IAssignTradeSectionRoleDataModel {
    tradeSectionId: string;
    assignUsers: IAssignUserModel[];
    unAssignUsers: string[];
}

interface IAssignTradeSectionRoleInsertDataModel {
    project_trade_section_id: string;
    user_id: string;
    role_id: string;
}

interface IAssignUserInTradeSection {
    id: string;
    trade_section_id: string;
    trade_section_name: string;
    members: IUserInTrade[];
}

interface IUserInTrade {
    id: string;
    user_id: string;
    name: string;
    email: string;
    role_code: string;
}

interface IUserResult {
    id: string;
    name: string;
    role_names: { name: string }[];
}

interface IUserData {
    id: string;
    name: string;
    roles: string[];
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

        const { success, roles, allowUpdateTrades, error } = await isUserAllowToUpdateProject(loginUserId, projectId);
        if (!success) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', error || 'Failed to get user roles'));
        }

        const assignProjectRoles: IAssignProjectRolesDataModel = body.assignProjectRoles;
        const assignTradeSectionRole: IAssignTradeSectionRoleDataModel[] = body.assignTradeSectionRole;

        const userIds: string[] = getUserIds(assignProjectRoles, assignTradeSectionRole);

        // Get current project status
        const currentProjectStatus = await getProjectStatusById(projectId);

        if (currentProjectStatus === ProjectStatus['Closed']) {
            return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Cannot update a closed project'));
        }

        const operations: Operation[] = [];

        // Get existing assignments
        const existingAssignments = await getAssignUser(projectId);

        // Get existing trade members grouped by trade section
        const existingTradeMembersBySection = await getAssignUserInTradeSection(projectId);

        const userDatas: IUserData[] = await getUserDatas(userIds);

        validateAssignProjectRoles(assignProjectRoles, existingAssignments, projectId, operations, userDatas, roles);

        await validateAssignTradeMemberRoles(assignTradeSectionRole, existingTradeMembersBySection, roles, operations, userDatas, allowUpdateTrades);

        console.log(`Operations: `, JSON.stringify(operations, null, 2));
        // Perform all updates in a transaction
        const transactionResult = await performTransaction(operations);

        if (!transactionResult.success) {
            console.error('Transaction failed:', transactionResult.error);
            return new LambdaResponse(400, buildError('DATABASE_ERROR', transactionResult.error || 'Failed to update project'));
        }

        // Get updated project data from first operation result
        const updatedProject = transactionResult.results?.[0] ? transactionResult.results[0][0] : null;

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

function getUserIds(assignProjectRoles: IAssignProjectRolesDataModel, assignTradeSectionRole: IAssignTradeSectionRoleDataModel[]) {
    const userIds = new Set<string>();

    if (assignProjectRoles && Array.isArray(assignProjectRoles.assignUsers)) {
        assignProjectRoles.assignUsers.forEach((user: IAssignUserModel) => {
            if (user.userId) {
                if (isValidCognitoSub(user.userId)) {
                    userIds.add(user.userId);
                } else {
                    console.error('getUserIds: Invalid project role user ID:', user.userId);
                    throw new ValidationError(`Invalid user id format`);
                }
            }
        });
    }

    if (assignTradeSectionRole && Array.isArray(assignTradeSectionRole)) {
        assignTradeSectionRole.forEach((trade: IAssignTradeSectionRoleDataModel) => {
            if (trade.assignUsers && Array.isArray(trade.assignUsers)) {
                trade.assignUsers.forEach((user: IAssignUserModel) => {
                    if (user.userId) {
                        if (isValidCognitoSub(user.userId)) {
                            userIds.add(user.userId);
                        } else {
                            console.error('getUserIds: Invalid trade section role user ID:', user.userId);
                            throw new ValidationError(`Invalid user id format`);
                        }
                    }
                });
            }
        });
    }
    return Array.from(userIds);
}

async function getUserDatas(userIds: string[]): Promise<IUserData[]> {
    const usersResult = await executeQuery(`SELECT u.id, u.name, 
                ARRAY_AGG(DISTINCT jsonb_build_object('name', r.name)) as role_names 
                FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.id = ANY($1) 
                GROUP BY u.id, u.name`, [userIds]);
    console.log('User data count:', usersResult.data?.length || 0);

    if (!usersResult.success) {
        console.error('Failed to validate user IDs:', usersResult.error?.message || 'Unknown error');
        throw new DataBaseError('Failed to validate user IDs');
    }

    if (usersResult.data.length !== userIds.length) {
        throw new ValidationError('One or more user IDs are invalid');
    }

    // Create userDatas from query results and add any users from existingAssignments
    // For log history feature
    return usersResult.data.map((user: IUserResult) => ({
        id: user.id,
        name: user.name,
        roles: user.role_names.map(role => role.name)
    }));
}

function validateAssignProjectRoles(assignProjectRoles: IAssignProjectRolesDataModel, existingAssignments: IUserAssignRole[], projectId: string,
    operations: Operation[], userDatas: IUserData[], roles: number[]
) {
    const assignUser = assignProjectRoles.assignUsers ?? [];
    const unAssignUsers = assignProjectRoles.unAssignUsers ?? [];

    if ((assignUser.length > 0 || unAssignUsers.length > 0) && roles.length === 0) {
        throw new ValidationError('User does not has permission to modify assign user');
    }

    const unAssignValidated: string[] = [];
    const reAssignUsers: IUserAssignRole[] = [];

    validateUnAssign(unAssignUsers, existingAssignments, roles, assignUser, unAssignValidated, reAssignUsers);

    if (unAssignValidated.length > 0) {
        operations.push({
            type: 'query',
            queryText: `DELETE FROM project_assignments WHERE id = ANY($1)`,
            params: [unAssignValidated],
        })
    }

    const newAssignments: IAssignProjectRolesInsertDataModel[] = [];

    validateAssign(assignUser, existingAssignments, reAssignUsers, roles, newAssignments, projectId);

    if (newAssignments.length > 0) {
        const values = newAssignments.map((_, index) =>
            `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`
        ).join(', ');
        const params = newAssignments.flatMap(a => [a.user_id, a.role, a.role_code, a.project_id]);

        operations.push({
            type: 'query',
            queryText: `INSERT INTO project_assignments (user_id, role, role_code, project_id) VALUES ${values}`,
            params: params,
        });
    }
}

function validateAssign(assignUser: IAssignUserModel[], existingAssignments: IUserAssignRole[], reAssignUsers: IUserAssignRole[], roles: number[], newAssignments: IAssignProjectRolesInsertDataModel[], projectId: string) {
    for (const newAssign of assignUser) {
        if (!isValidCognitoSub(newAssign.userId)) {
            throw new ValidationError(`Invalid user ID format: ${newAssign.userId}`);
        }

        if (!(newAssign.role in RoleEnum)) {
            throw new ValidationError(`Invalid role: ${newAssign.role}`);
        }

        const role = RoleEnum[newAssign.role as keyof typeof RoleEnum];
        const roleCode = RoleCodeEnum[newAssign.role as keyof typeof RoleCodeEnum];
        const existingAssign = existingAssignments.find(a => (a.user_id === newAssign.userId && a.role === role));
        if (existingAssign) {
            if (reAssignUsers.length > 0 && reAssignUsers.find(a => a.id === existingAssign.id)) {
                continue;
            }
            throw new ValidationError(`User ${newAssign.userId} is already assigned to this project with role ${newAssign.role}`);
        }

        validateRolePermission(role, roles);

        newAssignments.push({ user_id: newAssign.userId, role: role, role_code: roleCode, project_id: projectId });
    }
}

function validateRolePermission(role: RoleEnum, roles: number[]) {
    if (role === RoleEnum.SRM) {
        if (roles.length === 1 && roles[0] === RoleEnum.SRM) {
            throw new ValidationError(`User does not have required role: Super User or Commercial Officer Admin`);
        }
    } else if (role === RoleEnum['Super User']) {
        throw new ValidationError(`Cannot modify Super User role`);
    } else if (role === RoleEnum['Commercial Officer Admin']) {
        throw new ValidationError(`Cannot modify Commercial Officer Admin role`);
    }
}

function validateUnAssign(unAssignUsers: string[], existingAssignments: IUserAssignRole[], roles: number[], assignUser: IAssignUserModel[], unAssignValidated: string[], reAssignUsers: IUserAssignRole[]) {
    for (const assignId of unAssignUsers) {
        if (!isValidUUID(assignId)) {
            throw new ValidationError(`Invalid unassign ID format: ${assignId}`);
        }
        const existingAssign = existingAssignments.find(a => a.id === assignId);
        if (!existingAssign) {
            throw new ValidationError(`Assign id ${assignId} is not existed to this project`);
        }

        validateRolePermission(existingAssign.role, roles);

        const newAssign = assignUser.find(a => {
            const role = RoleEnum[a.role as keyof typeof RoleEnum];
            return a.userId === existingAssign.user_id && role === existingAssign.role;
        });

        if (!newAssign) {
            unAssignValidated.push(assignId);
        } else {
            reAssignUsers.push(existingAssign);
        }
    }
}

async function isUserAllowToUpdateProject(userId: string, projectId: string) {
    let userRoles: number[] = [];
    let allowUpdateTrades: string[] = [];
    console.log(`UserId: ${userId}, ProjectId: ${projectId}`);
    const query = `
        SELECT p.vessel_name as project_name, pa.role
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
    let projectName: string | null = null;

    if (result.rowCount && result.rowCount > 0) {
        projectName = result.data[0].project_name;
    }

    const queryTradeRole = `SELECT pts.trade_section_id FROM project_trade_section_assigns ptsa 
        JOIN project_trade_sections pts ON ptsa.project_trade_section_id = pts.id 
        JOIN roles r ON r.id = ptsa.role_id WHERE pts.project_id = $1 AND ptsa.user_id = $2 AND r.code = $3`
    const tradeRolesResult = await executeQuery(queryTradeRole, [projectId, userId, TradeMemberRoleCode['Head of Department']]);

    if (!tradeRolesResult.success) {
        console.error('Failed to fetch trade roles:', tradeRolesResult.error?.message || 'Unknown error');
        throw new DataBaseError('Failed to fetch trade roles');
    }

    if (!tradeRolesResult.rowCount || tradeRolesResult.rowCount === 0) {
        console.log('getUserRoles: No trade section with user as HOD founded');
    } else {
        allowUpdateTrades = tradeRolesResult.data.map((row: { trade_section_id: string }) => row.trade_section_id);
    }

    if (!result.rowCount || result.rowCount === 0) {
        console.log('getUserRoles: No roles SRM or Super User or Commercial Officer Admin found for user');
    } else {
        userRoles = result.data.filter((row: { role: number | null }) => row.role !== null).map((row: { role: number }) => row.role);
    }

    if (userRoles.length === 0 && allowUpdateTrades.length === 0) {
        console.error('getUserRoles: No roles allow update found for user');
        return { success: false, roles: userRoles, allowUpdateTrades, error: `User does not has permission to update project ${projectName}` };
    }

    return { success: true, roles: userRoles, allowUpdateTrades, error: null };
}

async function getProjectStatusById(projectId: string): Promise<Number> {
    const projectResult = await executeQuery(`SELECT status FROM projects WHERE id = $1`, [projectId]);

    if (!projectResult.success) {
        console.error('Failed to fetch project:', projectResult.error?.message || 'Unknown error');
        throw new DataBaseError('Failed to fetch project');
    }

    if (!projectResult.data || projectResult.data.length === 0) {
        throw new ValidationError('Project not found');
    }

    const currentProjectStatus = projectResult.data[0]?.status;

    if (typeof currentProjectStatus !== 'number') {
        throw new ValidationError('Project status not valid');
    }

    return currentProjectStatus;
}

async function getAssignUser(projectId: string): Promise<IUserAssignRole[]> {
    const assignmentsResult = await executeQuery(
        'SELECT pa.id, pa.role, pa.user_id, u.name, u.email FROM project_assignments pa LEFT JOIN users u ON pa.user_id = u.id WHERE pa.project_id = $1',
        [projectId]
    );

    if (!assignmentsResult.success) {
        console.error('Failed to fetch assign user:', assignmentsResult.error?.message || 'Unknown error');
        throw new DataBaseError('Failed to fetch assign user');
    }

    return assignmentsResult.data;
}

async function getAssignUserInTradeSection(projectId: string): Promise<IAssignUserInTradeSection[]> {
    const tradeMembersResult = await executeQuery(
        `SELECT pts.id, pts.trade_section_id, ts.name as trade_section_name,
                ptsa.id as assign_id, ptsa.user_id, u.name, u.email, r.code as role_code
            FROM project_trade_sections pts 
            JOIN trade_sections ts ON pts.trade_section_id = ts.id
            LEFT JOIN project_trade_section_assigns ptsa ON pts.id = ptsa.project_trade_section_id 
            LEFT JOIN users u ON ptsa.user_id = u.id 
            LEFT JOIN roles r ON ptsa.role_id = r.id
            WHERE pts.project_id = $1
            ORDER BY pts.id`,
        [projectId]
    );

    if (!tradeMembersResult.success) {
        console.error('Failed to fetch assign user by trade:', tradeMembersResult.error?.message || 'Unknown error');
        throw new DataBaseError('Failed to fetch assign user by trade section');
    }

    const groupedData = new Map<string, IAssignUserInTradeSection>();

    for (const row of tradeMembersResult.data) {
        const key = `${row.id}-${row.trade_section_id}`;

        if (!groupedData.has(key)) {
            groupedData.set(key, {
                id: row.id,
                trade_section_id: row.trade_section_id,
                trade_section_name: row.trade_section_name,
                members: []
            });
        }

        if (row.assign_id) {
            groupedData.get(key)!.members.push({
                id: row.assign_id,
                user_id: row.user_id,
                name: row.name,
                email: row.email,
                role_code: row.role_code
            });
        }
    }

    return Array.from(groupedData.values());
}

async function validateAssignTradeMemberRoles(assignTradeSectionRole: IAssignTradeSectionRoleDataModel[], existingTradeMembersBySection: IAssignUserInTradeSection[],
    roles: number[], operations: Operation[], userDatas: IUserData[], allowUpdateTrades: string[]) {
    const unAssignTradeMember: string[] = [];
    const assignTradeMember: IAssignTradeSectionRoleInsertDataModel[] = [];

    validateRolePermissionInTrade(roles, assignTradeSectionRole, allowUpdateTrades, existingTradeMembersBySection);

    const { foremanRoleId, supervisorRoleId } = await getRoleIdsByCode();

    for (const assignTrade of assignTradeSectionRole) {
        const tradeSectionId = assignTrade.tradeSectionId;

        if (!isValidUUID(tradeSectionId)) {
            throw new ValidationError(`Invalid trade section ID format`);
        }

        const assignedTrade = existingTradeMembersBySection.find((trade: IAssignUserInTradeSection) => trade.trade_section_id === tradeSectionId);
        if (!assignedTrade) {
            throw new ValidationError(`Trade section does not exist in project`);
        }

        handleAlreadyAssignTradeSection(assignedTrade, assignTrade, unAssignTradeMember, foremanRoleId, supervisorRoleId, assignTradeMember);
    }

    if (unAssignTradeMember.length > 0) {
        operations.push({
            type: 'query',
            queryText: `DELETE FROM project_trade_section_assigns WHERE id = ANY($1)`,
            params: [unAssignTradeMember],
        })
    }

    if (assignTradeMember.length > 0) {
        const values = assignTradeMember.map((_, index) =>
            `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`
        ).join(', ');
        const params = assignTradeMember.flatMap(a => [a.project_trade_section_id, a.user_id, a.role_id]);

        operations.push({
            type: 'query',
            queryText: `INSERT INTO project_trade_section_assigns (project_trade_section_id, user_id, role_id) VALUES ${values}`,
            params: params,
        });
    }
}

function validateRolePermissionInTrade(roles: number[], assignTradeSectionRole: IAssignTradeSectionRoleDataModel[], allowUpdateTrades: string[], existingTradeMembersBySection: IAssignUserInTradeSection[]) {
    // SRM, COA OR SU can assign trade user
    // Not SRM, COA OR SU then HOD of that trade can update
    if (roles.length === 0) {
        for (const assignTrade of assignTradeSectionRole) {
            const tradeSectionId = assignTrade.tradeSectionId;
            if ((assignTrade.assignUsers.length > 0 || assignTrade.unAssignUsers.length > 0) && !allowUpdateTrades.includes(tradeSectionId)) {
                const assignedTrade = existingTradeMembersBySection.find(t => t.trade_section_id === tradeSectionId);
                const tradeSectionName = assignedTrade?.trade_section_name || tradeSectionId;
                throw new ValidationError(`User does not has permission to update trade section ${tradeSectionName}`);
            }
        }
    }
}

function handleAlreadyAssignTradeSection(assignedTrade: IAssignUserInTradeSection, assignTrade: IAssignTradeSectionRoleDataModel, unAssignTradeMember: string[], foremanRoleId: string, supervisorRoleId: string, assignTradeMember: IAssignTradeSectionRoleInsertDataModel[]) {
    const assignUsers = assignTrade.assignUsers ?? [];
    const tradeSectionId = assignTrade.tradeSectionId;
    const unAssignUsers = assignTrade.unAssignUsers ?? [];
    const reAssignUsers: IUserInTrade[] = [];

    const existingTradeMembers = assignedTrade.members ?? [];
    const assignedTradeId = assignedTrade.id;

    // Validate unassign users
    for (const unAssignId of unAssignUsers) {
        if (!isValidUUID(unAssignId)) {
            throw new ValidationError(`Invalid unassign ID format: ${unAssignId}`);
        }
        const existingMember = existingTradeMembers.find(m => m.id === unAssignId);
        if (!existingMember) {
            throw new ValidationError(`The assign id ${unAssignId} is not exist in trade section ${tradeSectionId}`);
        }

        const newAssign = assignUsers.find(a => {
            const roleCode = TradeMemberRoleCode[a.role as keyof typeof TradeMemberRoleCode];
            return a.userId === existingMember.user_id && roleCode === existingMember.role_code;
        });

        if (newAssign) {
            reAssignUsers.push(existingMember);
        } else {
            unAssignTradeMember.push(unAssignId);
        }
    }

    // Validate assign users
    for (const assignUser of assignUsers) {
        if (!isValidCognitoSub(assignUser.userId)) {
            throw new ValidationError(`Invalid user ID format: ${assignUser.userId}`);
        }

        if (!(assignUser.role in TradeMemberRoleCode)) {
            throw new ValidationError(`Invalid role: ${assignUser.role}`);
        }

        const roleCode = TradeMemberRoleCode[assignUser.role as keyof typeof TradeMemberRoleCode];
        const existingMember = existingTradeMembers.find(m => (m.user_id === assignUser.userId && m.role_code === roleCode));
        if (existingMember) {
            if (reAssignUsers.length > 0 && reAssignUsers.find(a => a.id === existingMember.id)) {
                continue;
            }
            throw new ValidationError(`User is already assigned to this trade section with this role`);
        }

        // Not allow assign HOD so only FOM and SU
        const roleId = roleCode === TradeMemberRoleCode.Foreman ? foremanRoleId : supervisorRoleId;
        assignTradeMember.push({ user_id: assignUser.userId, role_id: roleId, project_trade_section_id: assignedTradeId });
    }
}

async function getRoleIdsByCode(): Promise<{ foremanRoleId: string; supervisorRoleId: string; }> {
    let foremanRoleId: string | null = null;
    let supervisorRoleId: string | null = null;
    interface RoleDetail {
        id: string;
        code: string;
    }
    const roleCodes = [TradeMemberRoleCode.Foreman, TradeMemberRoleCode.Supervisor];
    const selectRoleByCodeResult = await executeQuery(`SELECT id, code FROM roles WHERE code = ANY($1)`, [roleCodes]);
    if (!selectRoleByCodeResult.success) {
        throw new DataBaseError(`Error retrieving role information`);
    }
    if (selectRoleByCodeResult.rowCount === 0) {
        throw new ValidationError(`Required roles not found in system`);
    }
    const roleData: RoleDetail[] = selectRoleByCodeResult.data;
    const roleMap = new Map(roleData.map(role => [role.code, role.id]));

    foremanRoleId = roleMap.get(TradeMemberRoleCode.Foreman) || null;
    supervisorRoleId = roleMap.get(TradeMemberRoleCode.Supervisor) || null;

    if (!foremanRoleId || !supervisorRoleId) {
        throw new ValidationError(`Not found id for required role ${TradeMemberRoleCode.Foreman} or ${TradeMemberRoleCode.Supervisor}`);
    }

    return { foremanRoleId, supervisorRoleId };
}