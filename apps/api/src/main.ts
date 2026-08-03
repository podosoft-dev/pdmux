import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const corsOrigin = process.env.CORS_ORIGIN?.split(",").map((o) => o.trim());
  app.enableCors({ origin: corsOrigin ?? true, credentials: true });

  const config = new DocumentBuilder()
    .setTitle("pdmux API")
    .setDescription("Generated with PodoKit")
    .setVersion("0.0.0")
    .build();
  SwaggerModule.setup("api-docs", app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 5002);
  await app.listen(port);
}

void bootstrap();
