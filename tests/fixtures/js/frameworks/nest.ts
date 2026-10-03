import { Controller, Get, Post, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  list() {
    return [];
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return id;
  }

  @Post('bulk')
  async bulk() {}
}
