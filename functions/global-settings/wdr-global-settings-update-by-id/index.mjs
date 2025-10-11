import { updateRecord } from 'wdr-connect-db';
import { ApiResponse } from 'wdr-models';

export const handler = async (event) => {
  console.log('Receive event', event);

  try {
    const globalSettingId = event.id;

    if (!globalSettingId) {
      return new ApiResponse(false, null, 'Global setting id is required');
    }

    const body = event.requestBody || '{}';

    const globalSettingData = {};

    if (body.fileSize !== undefined) {
      if (typeof body.fileSize !== 'number' || body.fileSize <= 0) {
        return new ApiResponse(false, null, 'File size must be a positive number');
      }
      globalSettingData.file_size = body.fileSize;
    }

    if (body.maxCompress !== undefined) {
      if (typeof body.maxCompress !== 'number' || body.maxCompress < 0 || body.maxCompress > 100) {
        return new ApiResponse(false, null, 'Max compress must be a number between 0 and 100');
      }
      globalSettingData.max_compress = body.maxCompress;
    }

    if (body.fontSize !== undefined) {
      if (typeof body.fontSize !== 'number' || body.fontSize <= 0) {
        return new ApiResponse(false, null, 'Font size must be a positive number');
      }
      globalSettingData.font_size = body.fontSize;
    }

    if (body.isAutoSave !== undefined) {
      if (typeof body.isAutoSave !== 'boolean') {
        return new ApiResponse(false, null, 'Is auto save must be a boolean');
      }
      globalSettingData.is_auto_save = body.isAutoSave;
    }

    if (body.autoSaveTime !== undefined) {
      if (typeof body.autoSaveTime !== 'number' || body.autoSaveTime <= 0) {
        return new ApiResponse(false, null, 'Auto save time must be a positive number');
      }
      globalSettingData.auto_save_time = body.autoSaveTime;
    }

    if (Object.keys(globalSettingData).length === 0) {
      return new ApiResponse(false, null, 'No valid fields to update');
    }

    console.log('Global setting Data:', globalSettingData);

    const result = await updateRecord('global_settings', globalSettingData, {id : globalSettingId});
    console.log('Result:', result);

    if (result.success) {
      return new ApiResponse(true, result.data, 'Global setting updated successfully');
    }

    return new ApiResponse(false, null, 'Global setting updated failed!', result);
    
  } catch (error) {
    console.error('Error:', error);
    return new ApiResponse(false, null, 'Internal server error', error.message);
  }
};