/*
  Varredura I2C — rode ANTES do firmware principal para descobrir os
  endereços reais do MPU6050 e do LCD (uPesy ESP32-C3 Mini).
  Mesmos pinos do firmware: SDA = GPIO 1, SCL = GPIO 0.
  Arduino IDE: "USB CDC On Boot: Enabled"; Monitor Serial a 115200.

  Endereços típicos (apenas referência — confira o resultado real):
    MPU6050 (GY-521): 0x68 (AD0 em GND) ou 0x69 (AD0 em 3V3)
    LCD com PCF8574:  0x20–0x27   ·   com PCF8574A: 0x38–0x3F
*/
#include <Wire.h>

const int PIN_I2C_SDA = 1;
const int PIN_I2C_SCL = 0;

void setup() {
  Serial.begin(115200);
  delay(1500);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
}

void loop() {
  Serial.println("\nVarrendo o barramento I2C...");
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      const char* hint = (addr == 0x68 || addr == 0x69)                     ? "  (provável MPU6050)"
                         : (addr >= 0x20 && addr <= 0x27) || (addr >= 0x38 && addr <= 0x3F) ? "  (provável LCD PCF8574)"
                                                                            : "";
      Serial.printf("  encontrado: 0x%02X%s\n", addr, hint);
      found++;
    }
  }
  if (!found) Serial.println("  nenhum dispositivo: verifique SDA/SCL, GND comum e alimentação.");
  delay(3000);
}
