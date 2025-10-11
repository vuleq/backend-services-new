import { updateRecord, executeQuery } from 'wdr-connect-db';
import { ApiResponse, LambdaResponse } from 'wdr-models';
import { isValidUUID, isValidCognitoSub, decodeToken } from 'wdr-common-utils';
import { buildError } from 'wdr-error-codes';

const definedTypeEnum = {
  'Pre-defined text': 0,
  'Standard checklist': 1,
  'Dynamic values': 2
}

function getLoginUserInfo(requestHeader) {
  let loginUserId = null; // Default user ID for system admin
  let loginUserName = null;

  if (requestHeader) {
    let token = requestHeader["Authorization"] || requestHeader["authorization"];
    // Parse JWT token
    if (token) {
      token = token.replace('Bearer ', '');
      const payload = decodeToken(token)?.payload;
      console.log('JWT Payload received');
      loginUserId = payload?.sub;
      loginUserName = payload?.name;
    }
  }
  return { loginUserId, loginUserName };
}

export const handler = async (event) => {
  console.log('Receive Event:', event);

  try {
    const { id } = event.pathParameters || {};
    let { name, data, description, tradeSectionId, workCategoryId } = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};

    if (!id) {
      return new LambdaResponse(400, buildError('MISSING_REQUIRED_FIELD', 'Pre defined id is required'));
    }

    if (!name) {
      return new LambdaResponse(400, buildError('MISSING_REQUIRED_FIELD', 'Missing update data'));
    }

    const requestHeader = event.headers;
    const { loginUserId, loginUserName } = getLoginUserInfo(requestHeader);

    if (!isValidCognitoSub(loginUserId)) {
      return new LambdaResponse(400, buildError('INVALID_REQUEST', 'No login user id provided'));
    }

    let updateData = {
      updated_by: loginUserId,
      updated_at: new Date()
    }

    const preDefinedResult = await executeQuery(`SELECT type, trade_section_id, work_category_id FROM pre_defined WHERE id = $1`, [id]);
    if (!preDefinedResult.success) {
      return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to get pre-defined'));
    }

    if (preDefinedResult.rowCount === 0) {
      return new LambdaResponse(400, buildError('ENTITY_VALIDATION_FAILED', 'Pre-defined not found'));
    }

    const type = preDefinedResult.data[0].type;
    if (type === definedTypeEnum['Dynamic values']) {
      data = null;
      tradeSectionId = null;
      workCategoryId = null;
    } else {
      description = null;
    }

    if (name) {
      updateData['name'] = name;
    }

    if (description) {
      updateData['description'] = description;
    }

    if (data) {
      try {
        updateData['data'] = JSON.parse(data);
      } catch (jsonError) {
        return new LambdaResponse(400, buildError('INVALID_REQUEST', 'Data must be valid JSON'));
      }
    }

    if (tradeSectionId && isValidUUID(tradeSectionId)) {
      const currentTradeSectionId = preDefinedResult.data[0].trade_section_id;
      let isChangeTradeSection = false;
      let newTradeWorkCategoryIds = [];
      if (currentTradeSectionId && currentTradeSectionId !== tradeSectionId) {
        isChangeTradeSection = true;
        const tradeSectionCheck = await executeQuery(`SELECT ts.id, ARRAY_AGG(wc.id) as work_category_ids FROM trade_sections ts 
          LEFT JOIN work_categories wc ON wc.trade_section_id = ts.id WHERE ts.id = $1 GROUP BY ts.id`, [tradeSectionId]);
        if (!tradeSectionCheck.success) {
          return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to check trade section'));
        }
        if (tradeSectionCheck.data.length === 0) {
          return new LambdaResponse(400, buildError('ENTITY_VALIDATION_FAILED', 'Trade section not found'));
        }
        newTradeWorkCategoryIds = tradeSectionCheck.data[0].work_category_ids || [];
        updateData['trade_section_id'] = tradeSectionId;
      }

      if (workCategoryId && isValidUUID(workCategoryId)) {
        const currentWorkCategoryId = preDefinedResult.data[0].work_category_id;
        if (currentWorkCategoryId && currentWorkCategoryId !== workCategoryId) {
          if (isChangeTradeSection) {
            if (!newTradeWorkCategoryIds.includes(workCategoryId)) {
              return new LambdaResponse(400, buildError('ENTITY_VALIDATION_FAILED', 'Work category does not belong to the selected trade section'));
            }
          } else {
            const workCategoryCheck = await executeQuery(`SELECT id FROM work_categories WHERE id = $1 AND trade_section_id = $2`, [workCategoryId, tradeSectionId]);
            if (!workCategoryCheck.success) {
              return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to check work category'));
            }
            if (workCategoryCheck.data.length === 0) {
              return new LambdaResponse(400, buildError('ENTITY_VALIDATION_FAILED', 'Work category does not belong to the trade section'));
            }
          }
          updateData['work_category_id'] = workCategoryId;
        }
      }
    }

    const updateResult = await updateRecord('pre_defined', updateData, { id: id });

    if (!updateResult.success) {
      return new LambdaResponse(400, buildError('DATABASE_ERROR', 'Failed to update pre-defined'));
    }

    if (updateResult.rowCount === 0) {
      return new LambdaResponse(400, buildError('ENTITY_UPDATE_FAILED', 'Pre-defined not found'));
    }

    return new LambdaResponse(200, new ApiResponse(true, updateResult.data, 'Pre defined updated successfully'));
  } catch (error) {
    console.error('Error:', error);
    return new LambdaResponse(400, buildError('ENTITY_UPDATE_FAILED', error.message));
  }

};
