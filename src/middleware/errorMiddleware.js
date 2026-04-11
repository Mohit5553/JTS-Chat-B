const sendErrorDev = (err, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    message: err.message,
    error: {
      code: err.code || "internal_error",
      details: err.details || null
    },
    stack: err.stack
  });
};

const sendErrorProd = (err, res) => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      error: {
        code: err.code || "operational_error",
        details: err.details || null
      }
    });
  } else {
    // Programming or other unknown error: don't leak error details
    console.error("ERROR 💥", err);
    res.status(500).json({
      status: "error",
      message: "Something went very wrong!",
      error: {
        code: "internal_error",
        details: null
      }
    });
  }
};

/**
 * Normalize common Mongoose/DB errors into operational AppError-like shapes
 * so they return proper HTTP codes instead of 500.
 */
function normalizeError(err) {
  // Mongoose ValidationError → 400
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors || {})
      .map((e) => e.message)
      .join("; ");
    err.statusCode = 400;
    err.status = "fail";
    err.message = messages || "Validation failed";
    err.isOperational = true;
  }

  // Mongoose CastError (bad ObjectId) → 400
  if (err.name === "CastError") {
    err.statusCode = 400;
    err.status = "fail";
    err.message = `Invalid ${err.path}: ${err.value}`;
    err.isOperational = true;
  }

  // Mongoose duplicate key (unique constraint) → 409
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {}).join(", ");
    err.statusCode = 409;
    err.status = "fail";
    err.message = `Duplicate value for: ${field}`;
    err.isOperational = true;
  }

  // JWT errors → 401
  if (err.name === "JsonWebTokenError") {
    err.statusCode = 401;
    err.status = "fail";
    err.message = "Invalid token. Please log in again.";
    err.isOperational = true;
  }
  if (err.name === "TokenExpiredError") {
    err.statusCode = 401;
    err.status = "fail";
    err.message = "Your session has expired. Please log in again.";
    err.isOperational = true;
  }

  return err;
}

const errorMiddleware = (err, req, res, next) => {
  err = normalizeError(err);
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  // Use detailed errors if in development OR if NODE_ENV is not set (typical for local dev)
  if (process.env.NODE_ENV === "development" || !process.env.NODE_ENV) {
    sendErrorDev(err, res);
  } else {
    sendErrorProd(err, res);
  }
};

export default errorMiddleware;
