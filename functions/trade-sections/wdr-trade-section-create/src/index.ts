import { executeQuery, performTransaction, Operation } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';
import { isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';
import { Handler, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

interface ITradeSectionDataModel {
  name: string;
  workCategories: string[];
}

export const handler: Handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Receive Event:', event);

  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
  const tradeSectionData: ITradeSectionDataModel = {
    name: body.name,
    workCategories: [...body.workCategories || []],
  }

  const requestHeader = event.headers;
  const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

  if (!loginUserId || !isValidCognitoSub(loginUserId)) {
    return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid user ID format'));
  }

  if (!tradeSectionData.name || tradeSectionData.name.trim() === '') {
    const err = buildError('MISSING_REQUIRED_FIELD', 'Trade section name is required');
    return new LambdaResponse(400, err);
  }

  try {
    const selectQuery = 'SELECT id FROM trade_sections WHERE name = $1';
    const selectResult = await executeQuery(selectQuery, [tradeSectionData.name]);

    if (!selectResult.success) {
      const err = buildError('DATABASE_ERROR', selectResult.error ?? 'Failed to check existing trade section');
      return new LambdaResponse(400, err);
    }

    if (selectResult.data.length > 0) {
      const err = buildError('RESOURCE_ALREADY_EXISTS', 'Trade section name already exists');
      return new LambdaResponse(400, err);
    }

    const operations: Operation[] = [
      {
        type: 'insert',
        table: 'trade_sections',
        data: {
          name: tradeSectionData.name,
          created_by: loginUserId,
          updated_by: loginUserId
        },
        returningClause: '*'
      }
    ];

    if (tradeSectionData.workCategories && tradeSectionData.workCategories.length > 0) {
      const { hasEmptyString, duplicates } = validateWorkCategories(tradeSectionData.workCategories);

      if (hasEmptyString) {
        const err = buildError('INVALID_REQUEST', 'Work categories cannot contain empty strings');
        return new LambdaResponse(400, err);
      }

      if (duplicates.length > 0) {
        const err = buildError('INVALID_REQUEST', `Duplicate work categories found: ${duplicates.join(', ')}`);
        return new LambdaResponse(400, err);
      }

      tradeSectionData.workCategories.forEach(subTrade => (operations.push({
        type: 'insert',
        table: 'work_categories',
        data: {
          trade_section_id: {
            type: 'dynamic_result',
            fromIndex: 0,
            field: 'id'
          },
          name: subTrade
        },
        returningClause: '*'
      })));
    }

    const result = await performTransaction(operations);

    if (!result.success) {
      const err = buildError('DATABASE_ERROR', result.error ?? 'Failed to create trade section');
      return new LambdaResponse(400, err);
    }

    const mainTradeSection = result.results?.[0][0];
    const subTradeSections = result.results?.slice(1).map(r => r[0]);

    return new LambdaResponse(200, new ApiResponse(true, {
      tradeSection: mainTradeSection,
      workCategories: subTradeSections
    }));
  } catch (error: any) {
    console.error('Error:', error);
    const err = buildError('DATABASE_ERROR', error.message);
    return new LambdaResponse(400, err);
  }
};

const validateWorkCategories = (arr: string[]) => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let hasEmptyString = false;

  for (const str of arr) {
    if (str.trim() === '') {
      hasEmptyString = true;
      continue;
    }

    if (seen.has(str)) {
      duplicates.push(str);
    } else {
      seen.add(str);
    }
  }

  return {
    hasEmptyString,
    duplicates
  }
};