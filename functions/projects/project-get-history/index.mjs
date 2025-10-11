import { executeQuery } from 'wdr-connect-db';
import { ApiResponse } from 'wdr-models';
import fs from 'fs/promises';

const jsonString = await fs.readFile('./historyActionsI18n.json', 'utf-8');
const historyActionsI18n = JSON.parse(jsonString);

function fillTemplate(template, values) {
    if (!template || !values) return template;
    return template.replace(/{{(\w+)}}/g, (match, key) => {
        return values[key] !== undefined ? values[key] : match;
    });
}

/**
 * Get history action or child action text by code and language
 * @param {string|number} code - Action type or child type code
 * @param {'historyActionType'|'historyActionChildType'} type - Which type to get
 * @param {string} [lang='en'] - Language code
 * @returns {string|null}
 */
function getHistoryActionText(code, type, lang = 'en') {
    const dict = historyActionsI18n?.[type]?.[String(code)];
    if (!dict) return null;
    return dict[lang] || null;
}

export const handler = async (event) => {
    console.log('Receive Event:', event);
    const id = event.pathParameters?.id || event.id;

    if (!id) {
        return new ApiResponse(false, null, 'Missing id parameter');
    }

    try {
        // Get project with assigned users
        const sql = `SELECT action_type, values, action_group, details FROM project_history WHERE project_id = $1`;
        const params = [id];
        const result = await executeQuery(sql, params);

        console.log('Select result:', result);

        if (result.error) {
            return new ApiResponse(false, null, 'Database error', result.error);
        }

        if (!result.data || result.data.length === 0) {
            return new ApiResponse(true, null, []);
        }

        const resultData = result.data.map((row) => {
            console.log('Row:', row);
            const actionString = getHistoryActionText(row.action_type, 'historyActionType');
            const values = row.values;
            const details = row.details;
            const detailsJson = [];
            console.log('Detail', details);
            if (details) {
                try {
                    if (Array.isArray(details)) {
                        detailsJson = details.map(action => {
                            const detailValues = JSON.parse(action.values);
                            const detailActionString = getHistoryActionText(action.action_type, 'historyActionChildType');
                            return {
                                action: fillTemplate(detailActionString, detailValues)
                            };
                        });
                    }
                } catch (e) {
                    console.log('Error when process details: ', e.message ?? e)
                }
            }
            return {
                title: fillTemplate(actionString, values),
                details: detailsJson
            };
        });

        return new ApiResponse(true, resultData, 'Project history retrieved successfully');
    } catch (error) {
        console.error('Error:', error);
        return new ApiResponse(false, null, 'Internal server error', error.message);
    }
};