import { Module } from '@nestjs/common';
import { BoxesController } from './boxes.controller.js';
import { BoxesService } from './boxes.service.js';

@Module({
  controllers: [BoxesController],
  providers: [BoxesService],
  exports: [BoxesService],
})
export class BoxesModule {}
