import { executeQuery, insertRecord, logAPIError, logDatabaseError } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { buildError } from 'wdr-error-codes';
import { isValidUUID, isValidCognitoSub, getLoginUserInfo } from 'wdr-common-utils';

const definedTypeEnum = {
  'Pre-defined text': 0,
  'Standard checklist': 1,
  'Dynamic values': 2,
  'Formula table': 3
}

export const handler = async (event) => {
  console.log('Receive Event:', event);

  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
  const requestHeader = event.headers;
  const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

  if (!loginUserId || !isValidCognitoSub(loginUserId)) {
    await logAPIError('Invalid user ID format');
    return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Invalid user ID format'));
  }

  const preDefinedData = {
    name: body.name,
    type: definedTypeEnum[body.definedType],
    created_by: loginUserId,
    updated_by: loginUserId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // Use a variable for dynamic type check
  const isDynamicType = preDefinedData.type === definedTypeEnum['Dynamic values'];

  // Validate required fields
  if (!preDefinedData.name || preDefinedData.name.trim() === '') {
    await logAPIError('Pre-defined name is required');
    return errorResponse('MISSING_REQUIRED_FIELD', 'Pre-defined name is required');
  }

  if (preDefinedData.type === undefined) {
    await logAPIError('Pre-defined type not existed');
    return errorResponse('INVALID_REQUEST', 'Pre-defined type not existed');
  }

  if (isDynamicType) {
    if (body.description && body.description.trim() !== '') {
      preDefinedData['description'] = body.description;
    }
  } else {
    if (!body.tradeSectionId || body.tradeSectionId.trim() === '' || !isValidUUID(body.tradeSectionId)) {
      await logAPIError('Trade section id is required');
      return errorResponse('MISSING_REQUIRED_FIELD', 'Trade section id is required');
    }
    preDefinedData['trade_section_id'] = body.tradeSectionId;

    if (!body.workCategoryId || body.workCategoryId.trim() === '' || !isValidUUID(body.workCategoryId)) {
      await logAPIError('Work category id is required');
      return errorResponse('MISSING_REQUIRED_FIELD', 'Work category id is required');
    }
    preDefinedData['work_category_id'] = body.workCategoryId;

    if (body.data) {
      try {
        // Validate and store as string if DB expects JSON string
        preDefinedData['data'] = JSON.stringify(JSON.parse(body.data));
      } catch (jsonError) {
        await logAPIError('Data must be valid JSON');
        return errorResponse('INVALID_REQUEST', 'Data must be valid JSON', jsonError);
      }
    }
  }

  try {
    // Check for existing record
    const selectQuery = isDynamicType
      ? 'SELECT EXISTS (SELECT 1 FROM pre_defined WHERE name = $1 AND type = $2) as exists'
      : 'SELECT EXISTS (SELECT 1 FROM pre_defined WHERE name = $1 AND work_category_id = $2 AND type = $3) as exists';
    const selectParams = isDynamicType
      ? [preDefinedData.name, preDefinedData.type]
      : [preDefinedData.name, preDefinedData.work_category_id, preDefinedData.type];

    const selectResult = await executeQuery(selectQuery, selectParams);

    if (!selectResult.success) {
      await logDatabaseError('Failed to check existing value');
      return errorResponse('DATABASE_ERROR', selectResult.error ?? 'Failed to check existing value', selectResult.error);
    }

    if (selectResult.data[0]?.exists) {
      await logDatabaseError(`Object with name ${preDefinedData.name} already exists`)
      return errorResponse('RESOURCE_ALREADY_EXISTS', `Object with name ${preDefinedData.name} already exists`);
    }

    // For non-dynamic types, check trade section and work category relationship
    if (!isDynamicType) {
      // Ensure trade_section_id and work_category_id are valid and related
      const checkTradeAndCategoryQuery = `SELECT EXISTS (SELECT 1 FROM trade_sections ts JOIN work_categories wc ON ts.id = wc.trade_section_id WHERE ts.id = $1 AND wc.id = $2)`;
      const checkTradeAndCategoryResult = await executeQuery(checkTradeAndCategoryQuery, [preDefinedData.trade_section_id, preDefinedData.work_category_id]);

      if (!checkTradeAndCategoryResult.success) {
        await logDatabaseError('Failed to check existing trade section and work category');
        return errorResponse('DATABASE_ERROR', checkTradeAndCategoryResult.error ?? 'Failed to check existing trade section and work category', checkTradeAndCategoryResult.error);
      }

      if (!checkTradeAndCategoryResult.data[0]?.exists) {
        await logAPIError('Trade section or work category not valid');
        return errorResponse('INVALID_REQUEST', 'Trade section or work category not valid');
      }
    }

    // Insert new record
    const insertResult = await insertRecord('pre_defined', preDefinedData);

    if (!insertResult.success) {
      await logDatabaseError('Failed to create pre-defined');
      return errorResponse('DATABASE_ERROR', insertResult.error ?? 'Failed to create pre-defined', insertResult.error);
    }

    return new LambdaResponse(200, new ApiResponse(true, insertResult.data));
  } catch (error) {
    console.error('Error:', error);
    await logDatabaseError('Unexpected database error');
    return errorResponse('DATABASE_ERROR', error.message, error);
  }
};

// Helper for consistent error responses
function errorResponse(code, message, errorObj) {
  if (errorObj) {
    console.error('Error details:', errorObj);
  }
  const err = buildError(code, message);
  return new LambdaResponse(err);
}
