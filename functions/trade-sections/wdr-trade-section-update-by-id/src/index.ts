import { performTransaction, executeQuery, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { buildError, DataBaseError, ValidationError } from 'wdr-error-codes';

interface ITradeSectionDataModel {
  name: string;
  workCategories: IWorkCategoryInput[];
}

interface IWorkCategory {
  id: string;
  name: string;
}

interface IWorkCategoryInput {
  id?: string;
  name: string;
}

interface ValidateWorkCategoriesResult {
  invalidIds: string[];
  newCategories: IWorkCategoryInput[];
  updateCategories: IWorkCategoryInput[];
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event - Path:', event.path, 'Method:', event.httpMethod);

  try {
    const { id } = event.pathParameters || {};
    let body: any = {};
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    } catch (parseError) {
      console.error('JSON parse error');
      return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid JSON format'));
    }

    const tradeSectionData: ITradeSectionDataModel = {
      name: body.name,
      workCategories: body.workCategories || []
    }

    if (!id || !isValidUUID(id)) {
      const err = buildError('MISSING_REQUIRED_FIELD', 'Trade section id is required');
      return new LambdaResponse(400, err);
    }

    if (!tradeSectionData.name) {
      const err = buildError('MISSING_REQUIRED_FIELD', 'Trade section name is required');
      return new LambdaResponse(400, err);
    }

    const requestHeader = event.headers;
    const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

    if (!loginUserId || !isValidCognitoSub(loginUserId)) {
      return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid user ID format'));
    }

    const existingWorkCategories = await getWorkCategoriesByTradeSectionId(id);

    const operations: Operation[] = [{
      type: 'update',
      table: 'trade_sections',
      data: { name: tradeSectionData.name, updated_by: loginUserId },
      condition: { id },
      returningClause: '*'
    }];

    const workCategories = tradeSectionData.workCategories;
    await handleWorkCategoriesChange(workCategories, existingWorkCategories, id, operations)

    const transactionResult = await performTransaction(operations);

    if (!transactionResult.success) {
      const err = buildError('DATABASE_ERROR', transactionResult.error ?? 'Trade section update failed');
      return new LambdaResponse(400, err);
    }

    // Build final work categories list
    let finalWorkCategories: IWorkCategory[] = [];
    if (workCategories && workCategories.length > 0) {
      // Create map of insert results by name for O(1) lookup
      const insertResultsByName = new Map<string, { id: string; name: string }>();
      const results = transactionResult.results ?? [];
      for (let i = 1; i < results.length; i++) { // Skip trade section update result
        const result = results[i];
        if (result && result[0]) {
          insertResultsByName.set(result[0].name, { id: result[0].id, name: result[0].name });
        }
      }

      workCategories.forEach(category => {
        if (category.id) {
          // Existing category (updated or no update needed)
          finalWorkCategories.push({ id: category.id, name: category.name });
        } else {
          // Find insert result for new category
          const insertResult = insertResultsByName.get(category.name);
          if (insertResult) {
            finalWorkCategories.push(insertResult);
          }
        }
      });
    }

    const result = {
      ...transactionResult.results?.[0][0],
      workCategories: finalWorkCategories
    }

    return new LambdaResponse(200, new ApiResponse(true, result, 'Trade section updated successfully'));
  } catch (err: any) {
    console.error('Error in update trade section:', err);
    if (err instanceof DataBaseError) {
      return new LambdaResponse(400, buildError('DATABASE_ERROR', err.message));
    }
    if (err instanceof ValidationError) {
      return new LambdaResponse(400, buildError('INVALID_REQUEST', err.message));
    }
    return new LambdaResponse(400, buildError('LAMBDA_SERVICE_EXCEPTION', 'An error occurred while update the trade section'));
  }
};

async function getWorkCategoriesByTradeSectionId(id: string): Promise<IWorkCategory[]> {
  const selectQuery = `
    SELECT 
      s.*,
      -- Aggregate work categories as JSON array, return empty array if none exist
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', wc.id,
            'name', wc.name
          )
        ) FILTER (WHERE wc.id IS NOT NULL), -- Only include non-null work categories
        '[]'::json -- Default to empty array if no work categories found
      ) as work_categories
    FROM trade_sections s 
    LEFT JOIN work_categories wc ON s.id = wc.trade_section_id 
    WHERE s.id = $1
    GROUP BY s.id
  `;

  const tradeSectionResult = await executeQuery(selectQuery, [id]);
  console.log('Query executed successfully, rows:', tradeSectionResult.rowCount);

  if (!tradeSectionResult.success) {
    throw new DataBaseError(tradeSectionResult.error ?? 'Failed to check existing trade section');
  }

  if (tradeSectionResult.rowCount === 0) {
    throw new ValidationError(tradeSectionResult.error ?? 'Trade section not found');
  }

  const tradeSection = tradeSectionResult.data[0];
  const existingWorkCategories: IWorkCategory[] = tradeSection.work_categories || [];
  return existingWorkCategories;
}

const findDuplicateNames = (arr: IWorkCategoryInput[]): string[] => {
  const seenNames = new Map<string, number>();
  const duplicateNames: string[] = [];

  for (const obj of arr) {
    const name = obj.name;
    if (seenNames.has(name)) {
      if (seenNames.get(name) === 1) {
        duplicateNames.push(name);
      }
      seenNames.set(name, seenNames.get(name)! + 1);
    } else {
      seenNames.set(name, 1);
    }
  }

  return duplicateNames;
};

async function handleWorkCategoriesChange(workCategories: IWorkCategoryInput[], existingWorkCategories: IWorkCategory[], id: string, operations: Operation[]) {
  // Handle work categories - update existing or insert new
  const existingIds = existingWorkCategories.map(wc => wc.id);
  const updateIds = workCategories.filter(wc => wc.id).map(wc => wc.id);
  const duplicateNames = findDuplicateNames(workCategories);

  if (duplicateNames.length > 0) {
    throw new ValidationError(`Duplicate work category names found: ${duplicateNames.join(', ')}`);
  }

  const toDelete = existingIds.filter(existingId => !updateIds.includes(existingId));
  console.log('Categories to delete count:', toDelete.length);

  if (toDelete.length > 0) {
    const checkPreDefined = await executeQuery('SELECT EXISTS (SELECT 1 FROM pre_defined WHERE work_category_id = ANY($1))', [toDelete]);
    if (!checkPreDefined.success) {
      throw new DataBaseError(checkPreDefined.error ?? 'Failed to check pre-defined');
    }

    console.log('Pre-defined check result:', checkPreDefined.data);
    if (checkPreDefined.data && checkPreDefined.data[0] && checkPreDefined.data[0].exists) {
      throw new ValidationError(`Cannot delete work categories with pre-defined values`);
    }

    operations.push({
      type: 'query',
      queryText: 'DELETE FROM work_categories WHERE id = ANY($1)',
      params: [toDelete]
    });
  }

  const { invalidIds, newCategories, updateCategories } = validateWorkCategories(workCategories, existingWorkCategories);

  if (invalidIds.length > 0) {
    throw new ValidationError(`Invalid work category IDs: ${invalidIds.join(', ')}`);
  }

  newCategories.forEach(category => {
    operations.push({
      type: 'insert',
      table: 'work_categories',
      data: {
        trade_section_id: id,
        name: category.name,
      },
      returningClause: 'id, name'
    });
  });

  updateCategories.forEach(category => {
    // Update existing
    operations.push({
      type: 'update',
      table: 'work_categories',
      data: { name: category.name },
      condition: { id: category.id },
      returningClause: 'id, name'
    });
  });
}


function validateWorkCategories(workCategories: IWorkCategoryInput[], existingWorkCategories: IWorkCategory[]): ValidateWorkCategoriesResult {
  let newCategories: IWorkCategoryInput[] = [];
  let updateCategories: IWorkCategoryInput[] = [];
  let noUpdateCategories: IWorkCategoryInput[] = [];
  let invalidIds: string[] = [];

  for (const wc of workCategories) {
    const id = wc.id;
    // Ensure categories name is valid
    if (!wc.name || wc.name.trim() === '') {
      throw new ValidationError(`Work category name is required for ID: ${id}`);
    }

    if (!id || id.trim() === '') {
      newCategories.push(wc);
    } else {
      const existCategory = existingWorkCategories.find(category => category.id === id);
      if (!existCategory) {
        invalidIds.push(id);
      } else if (existCategory.name !== wc.name) {
        updateCategories.push(wc);
      }
    }
  }
  return { invalidIds, newCategories, updateCategories };
}

