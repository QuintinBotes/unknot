using Shop.Api;
using Shop.Invoices;
using Shop.Orders;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddScoped<InvoiceGateway, PdfInvoiceGateway>();
builder.Services.AddScoped<OrderService>();
builder.Services.AddControllers().AddApplicationPart(typeof(OrdersController).Assembly);

var app = builder.Build();
app.MapControllers();
app.Run();
