import { BaseEntity, Entity, PrimaryColumn, Column } from "typeorm";

@Entity()
export class OpenApiSpec extends BaseEntity {
  @PrimaryColumn()
  name: string

  @Column()
  spec: string
}