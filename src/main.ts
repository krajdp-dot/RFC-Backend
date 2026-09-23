import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    // Phase 12: the WhatsApp webhook signature (X-Hub-Signature-256) is
    // an HMAC over the exact request bytes Meta sent. Express's default
    // JSON body parser discards those bytes once it parses them, so
    // without this, webhook signature verification would be checking a
    // re-serialized (and potentially differently-formatted) body instead
    // of what was actually signed — silently making verification
    // unreliable. This makes the original Buffer available as
    // request.rawBody alongside the normal parsed request.body.
    rawBody: true,
  });

  // Security
  app.use(helmet());

  // Phase 8: this filter already existed (fully written, with the exact
  // { success: false, error: { code, message, details, requestId } } shape
  // frontend/src/lib/fetchApi.ts already parses, and business-date-guard.util.ts
  // / day-close.service.ts already throw `code: 'BUSINESS_DATE_CLOSED'` for it
  // to surface) but was never actually registered anywhere — grepped the whole
  // backend for useGlobalFilters/APP_FILTER/@Catch usage sites and found none.
  // Every error was instead falling through to Nest's built-in default handler,
  // which has no `.code` field at all, silently breaking any frontend logic
  // meant to switch on it. Registering it changes no message wording for
  // ordinary HttpExceptions (same status, same message) — it only adds the
  // structure that was already designed in.
  app.useGlobalFilters(new GlobalExceptionFilter());

  const isProd = process.env.NODE_ENV === 'production';

  // CORS — allow Vercel frontend + localhost for dev
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://rfc-frontend-sigma.vercel.app',
    !isProd ? 'http://localhost:3000' : null,
  ].filter(Boolean) as string[];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  // Global prefix — exclude /health so Render's health-check hits the root path
  app.setGlobalPrefix('api/v1', {
    exclude: ['health'],
  });

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger / OpenAPI (only in non-production or always for now)
  const config = new DocumentBuilder()
    .setTitle('Rajdeep Fruits OS API')
    .setDescription('Backend API for Rajdeep Fruits Company')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  if (!isProd) {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Validate required env vars (only strictly require DB and JWT for now)
  const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET'];
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.error(`❌ Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }

  const port = process.env.PORT ?? 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`🍎 Rajdeep Fruits OS API running on port ${port}`);
  console.log(`📚 Swagger docs available at /api/docs`);
  console.log(`🔗 CORS allowed: ${allowedOrigins.join(', ')}`);
}
bootstrap();
