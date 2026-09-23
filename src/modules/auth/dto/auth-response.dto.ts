import { ApiProperty } from '@nestjs/swagger';

export class AuthResponseDto {
  @ApiProperty()
  token!: string;

  @ApiProperty()
  user!: any;

  @ApiProperty()
  business!: any;
}
