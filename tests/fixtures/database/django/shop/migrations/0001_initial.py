from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name='Order',
            fields=[
                ('id', models.BigAutoField(primary_key=True, serialize=False)),
                ('total', models.IntegerField(default=0)),
                ('note', models.CharField(max_length=100, null=True)),
            ],
        ),
    ]
