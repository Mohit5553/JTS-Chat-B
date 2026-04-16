/**
 * Simple logger utility that only logs in development
 */
export const logger = {
    log: (...args) => {
        if (process.env.NODE_ENV === 'development') {
            console.log(...args);
        }
    },
    error: (...args) => {
        // Always log errors
        console.error(...args);
    },
    warn: (...args) => {
        if (process.env.NODE_ENV === 'development') {
            console.warn(...args);
        }
    },
    info: (...args) => {
        if (process.env.NODE_ENV === 'development') {
            console.info(...args);
        }
    }
};