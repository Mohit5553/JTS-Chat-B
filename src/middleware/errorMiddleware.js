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

const errorMiddleware = (err, req, res, next) => {
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
