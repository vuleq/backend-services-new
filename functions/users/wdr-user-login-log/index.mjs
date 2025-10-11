import { executeQuery } from 'wdr-connect-db';

export const handler = async (event) => {
    console.log('=== Log Login Cognito Trigger Lambda Started ===');
    console.log('Event:', JSON.stringify(event, null, 2));

    const username = event.userName;
    const email = event.request.userAttributes.email;
    const now = new Date();

    const query = `INSERT INTO user_login_history (username, login_time, email)
    VALUES ($1, $2, $3)`;

    try {
        await executeQuery(query, [username, now, email]);
        console.log(`Saved login time for ${username} at ${now.toISOString()}`);
    } catch (error) {
        console.error('Error saving login time:', error);
    }

    return event;
};
