import { PartialType } from '@nestjs/swagger';
import { CreateSupplierDto } from './create-supplier.dto.js';

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}
