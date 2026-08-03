import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppException } from "./app-exception";

interface ErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    path: string;
    timestamp: string;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Internal server error";

    if (exception instanceof AppException) {
      statusCode = exception.statusCode;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      code = "HTTP_ERROR";
      message = exception.message;
    }

    const body: ErrorBody = {
      success: false,
      error: { code, message, statusCode, path: request.url, timestamp: new Date().toISOString() },
    };
    response.status(statusCode).json(body);
  }
}
